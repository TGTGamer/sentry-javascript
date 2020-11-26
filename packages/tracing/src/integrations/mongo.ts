import { Hub } from '@sentry/hub';
import { EventProcessor, Integration, SpanContext } from '@sentry/types';
import { fill, logger } from '@sentry/utils';

// TODO: Support Cursors? — Kamil

// This allows us to use the same array for both, defaults option and the type itself.
// (note `as const` at the end to make it a concrete union type, and not just string[])
type Operation = typeof OPERATIONS[number];
const OPERATIONS = [
  'aggregate', // aggregate(pipeline, options, callback)
  'bulkWrite', // bulkWrite(operations, options, callback)
  'countDocuments', // countDocuments(query, options, callback)
  'createIndex', // createIndex(fieldOrSpec, options, callback)
  'createIndexes', // createIndexes(indexSpecs, options, callback)
  'deleteMany', // deleteMany(filter, options, callback)
  'deleteOne', // deleteOne(filter, options, callback)
  'distinct', // distinct(key, query, options, callback)
  'drop', // drop(options, callback)
  'dropIndex', // dropIndex(indexName, options, callback)
  'dropIndexes', // dropIndexes(options, callback)
  'estimatedDocumentCount', // estimatedDocumentCount(options, callback)
  'findOne', // findOne(query, options, callback)
  'findOneAndDelete', // findOneAndDelete(filter, options, callback)
  'findOneAndReplace', // findOneAndReplace(filter, replacement, options, callback)
  'findOneAndUpdate', // findOneAndUpdate(filter, update, options, callback)
  'indexes', // indexes(options, callback)
  'indexExists', // indexExists(indexes, options, callback)
  'indexInformation', // indexInformation(options, callback)
  'initializeOrderedBulkOp', // initializeOrderedBulkOp(options, callback)
  'insertMany', // insertMany(docs, options, callback)
  'insertOne', // insertOne(doc, options, callback)
  'isCapped', // isCapped(options, callback)
  'mapReduce', // mapReduce(map, reduce, options, callback)
  'options', // options(options, callback)
  'parallelCollectionScan', // parallelCollectionScan(options, callback)
  'rename', // rename(newName, options, callback)
  'replaceOne', // replaceOne(filter, doc, options, callback)
  'stats', // stats(options, callback)
  'updateMany', // updateMany(filter, update, options, callback)
  'updateOne', // updateOne(filter, update, options, callback)
] as const;

const OPERATION_SIGNATURES: {
  [op in Operation]?: string[];
} = {
  bulkWrite: ['operations'],
  countDocuments: ['query'],
  createIndex: ['fieldOrSpec'],
  createIndexes: ['indexSpecs'],
  deleteMany: ['filter'],
  deleteOne: ['filter'],
  distinct: ['key', 'query'],
  dropIndex: ['indexName'],
  findOne: ['query'],
  findOneAndDelete: ['filter'],
  findOneAndReplace: ['filter', 'replacement'],
  findOneAndUpdate: ['filter', 'update'],
  indexExists: ['indexes'],
  insertMany: ['docs'],
  insertOne: ['doc'],
  mapReduce: ['map', 'reduce'],
  rename: ['newName'],
  replaceOne: ['filter', 'doc'],
  updateMany: ['filter', 'update'],
  updateOne: ['filter', 'update'],
};

interface Collection {
  collectionName: string;
  dbName: string;
  namespace: string;
  prototype: {
    [operation in Operation]: (...args: unknown[]) => unknown;
  };
}

interface MongoOptions {
  collection?: Collection;
  operations?: Operation[];
  describeOperations?: boolean | Operation[];
}

/** Tracing integration for node-postgres package */
export class Mongo implements Integration {
  /**
   * @inheritDoc
   */
  public static id: string = 'Mongo';

  /**
   * @inheritDoc
   */
  public name: string = Mongo.id;

  private _collection?: Collection;
  private _operations: Operation[];
  private _describeOperations?: boolean | Operation[];

  /**
   * @inheritDoc
   */
  public constructor(options: MongoOptions = {}) {
    this._collection = options.collection;
    this._operations = Array.isArray(options.operations)
      ? options.operations
      : ((OPERATIONS as unknown) as Operation[]);
    this._describeOperations = 'describeOperations' in options ? options.describeOperations : true;
  }

  /**
   * @inheritDoc
   */
  public setupOnce(_: (callback: EventProcessor) => void, getCurrentHub: () => Hub): void {
    // TODO: Detect mongo package and instrument automatically by default?
    if (!this._collection) {
      logger.error('Mongo Integration is missing a Mongo.Collection constructor');
      return;
    }
    this._instrumentOperations(this._collection, this._operations, getCurrentHub);
  }

  /**
   * Patches original collection methods
   */
  private _instrumentOperations(collection: Collection, operations: Operation[], getCurrentHub: () => Hub): void {
    operations.forEach((operation: Operation) => this._patchOperation(collection, operation, getCurrentHub));
  }

  /**
   * Patches original collection to utilize our tracing functionality
   */
  private _patchOperation(collection: Collection, operation: Operation, getCurrentHub: () => Hub): void {
    if (!(operation in collection.prototype)) return;

    const getSpanContext = this._getSpanContextFromOperationArguments.bind(this);

    fill(collection.prototype, operation, function(orig: () => void | Promise<unknown>) {
      return function(this: Collection, ...args: unknown[]) {
        const lastArg = args[args.length - 1];
        const scope = getCurrentHub().getScope();
        const transaction = scope?.getTransaction();

        // mapReduce is a special edge-case, as it's the only operation that accepts functions
        // other than the callback as it's own arguments. Therefore despite lastArg being
        // a function, it can be still a promise-based call without a callback.
        // mapReduce(map, reduce, options, callback) where `[map|reduce]: function | string`
        if (typeof lastArg !== 'function' || (operation === 'mapReduce' && args.length === 2)) {
          const span = transaction?.startChild(getSpanContext(this, operation, args));
          return (orig.call(this, ...args) as Promise<unknown>).then((res: unknown) => {
            span?.finish();
            return res;
          });
        }

        const span = transaction?.startChild(getSpanContext(this, operation, args.slice(0, -1)));
        return orig.call(this, ...args.slice(0, -1), function(err: Error, result: unknown) {
          span?.finish();
          lastArg(err, result);
        });
      };
    });
  }

  /**
   * Form a SpanContext based on the user input to a given operation.
   */
  private _getSpanContextFromOperationArguments(
    collection: Collection,
    operation: Operation,
    args: unknown[],
  ): SpanContext {
    const data: { [key: string]: string } = {
      collectionName: collection.collectionName,
      dbName: collection.dbName,
      namespace: collection.namespace,
    };
    const spanContext: SpanContext = {
      op: `query.${operation}`,
      data,
    };

    // If there was no signature available for us to be used for the extracted data description.
    // Or user decided to not describe given operation, just return early.
    const signature = OPERATION_SIGNATURES[operation];
    const shouldDescribe = Array.isArray(this._describeOperations)
      ? this._describeOperations.includes(operation)
      : this._describeOperations;

    if (!signature || !shouldDescribe) {
      return spanContext;
    }

    try {
      // Special case for `mapReduce`, as the only one accepting functions as arguments.
      if (operation === 'mapReduce') {
        const [map, reduce] = args as { name?: string }[];
        data[signature[0]] = typeof map === 'string' ? map : map.name || '<anonymous>';
        data[signature[1]] = typeof reduce === 'string' ? reduce : reduce.name || '<anonymous>';
      } else {
        for (let i = 0; i < signature.length; i++) {
          data[signature[i]] = JSON.stringify(args[i]);
        }
      }
    } catch (_oO) {
      // no-empty
    }

    return spanContext;
  }
}
