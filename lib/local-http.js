'use strict';
const http = require('http');

const LOCAL = '127.0.0.1';
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Gọi HTTP tới process bot trên cùng máy/container (PM2).
 * Dùng module http gốc thay cho fetch — tránh lỗi undici "fetch failed" trên một số môi trường Docker.
 */
function requestLocal({ port, path: pathname, method, headers, body, timeoutMs }) {
  let timeout = DEFAULT_TIMEOUT_MS;
  if (timeoutMs != null && timeoutMs !== '') {
    const n = Number(timeoutMs);
    if (Number.isFinite(n)) timeout = Math.max(1000, Math.min(n, DEFAULT_TIMEOUT_MS));
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: LOCAL,
        port: Number(port),
        path: pathname,
        method: method || 'GET',
        headers: headers || {},
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 500,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout khi gọi bot local'));
    });
    if (body != null && body !== '') {
      req.write(body);
    }
    req.end();
  });
}

function postJson(port, pathname, jsonBody) {
  const body = JSON.stringify(jsonBody || {});
  return requestLocal({
    port,
    path: pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
      'Content-Length': Buffer.byteLength(body, 'utf8'),
    },
    body,
  });
}

function getJson(port, pathname, extraHeaders, timeoutMs) {
  return requestLocal({
    port,
    path: pathname,
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(extraHeaders || {}),
    },
    timeoutMs,
  });
}

module.exports = { requestLocal, postJson, getJson };
