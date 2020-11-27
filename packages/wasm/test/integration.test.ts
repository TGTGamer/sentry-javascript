import * as Sentry from '@sentry/browser';
import { Event } from '@sentry/types';
import { TestClient } from '../../core/test/mocks/client';

import { Wasm } from '../src';

import { readFile } from 'fs';
import { Hub } from '@sentry/browser';

let exceptionEvent: Event;

function fakeFetch(file: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    readFile(`${__dirname}/${file}`, (err, buf) => {
      if (err) {
        return reject(err);
      }
      let resp = new Response(buf);
      Object.defineProperty(resp, 'url', { value: `http://localhost:8002/${file}` });
      return resolve(resp);
    });
  });
}

async function getInternalFunc(): Promise<WebAssembly.ExportValue> {
  const module = await WebAssembly.instantiateStreaming(fakeFetch('simple.wasm'), {
    env: {
      external_func: () => {
        throw Error('I failed');
      },
    },
  });
  return module.instance.exports.internal_func;
}

describe('Wasm', () => {
  beforeEach(() => {
    exceptionEvent = {
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  colno: 7,
                  filename: 'http://localhost:8002/',
                  function: 'async*',
                  in_app: true,
                  lineno: 41,
                },
                {
                  colno: 9,
                  filename: 'http://localhost:8002/',
                  function: '?',
                  in_app: true,
                  lineno: 37,
                },
                {
                  filename: 'http://localhost:8002/simple.wasm:wasm-function[1]:0x8c',
                  function: 'internal_func',
                  in_app: true,
                },
                {
                  colno: 13,
                  filename: 'http://localhost:8002/',
                  function: 'crash',
                  in_app: true,
                  lineno: 23,
                },
              ],
            },
          },
        ],
      },
    };
  });

  describe('captures wasm errors', () => {
    it('should be titled "Google"', async () => {
      await page.goto('file://' + __dirname + '/simple.html');
      await expect(page.title()).resolves.toMatch('Google');
    });
    /*
    const client = new TestClient({
      integrations: [new Wasm()],
      beforeSend: event => {
        console.log(event);
        return null;
      },
    });
    const hub = new Hub();
    hub.bindClient(client);
    hub.run(async () => {
      try {
        await getInternalFunc();
      } catch (err) {
        Sentry.captureException(err);
      }
    });
    */
  });

  /*
  describe('bails when unable to extract frames', () => {
    it('no exception values', () => {
      const brokenEvent = {
        exception: {
          values: undefined,
        },
      };
      //     expect(wasm.process(brokenEvent)).toEqual(brokenEvent);
    });

    it('no frames', () => {
      const brokenEvent = {
        exception: {
          values: [
            {
              stacktrace: {},
            },
          ],
        },
      };
      //  expect(wasm.process(brokenEvent)).toEqual(brokenEvent);
    });
  });
  */
});
