/*
 * Copyright 2025 The Yorkie Authors. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import http from "k6/http";
import { Client, Stream } from "k6/net/grpc";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { b64encode } from "k6/encoding";
import exec from "k6/execution";

const API_URL = __ENV.API_URL || "http://localhost:8080";
const API_KEY = __ENV.API_KEY || "";
const DOC_KEY_PREFIX = __ENV.DOC_KEY_PREFIX || "test-watch";
const TEST_MODE = __ENV.TEST_MODE || "skew"; // skew | even
const CONCURRENCY = parseInt(__ENV.CONCURRENCY || "500", 10);
const VU_PER_DOCS = parseInt(__ENV.VU_PER_DOCS || "10", 10);
const WATCHER_RATIO = parseFloat(__ENV.WATCHER_RATIO || "0.5"); // 0~1

export const options = {
  scenarios: {
    watchers: {
      executor: "ramping-vus",
      stages: [
        { duration: "1m", target: Math.round(CONCURRENCY * WATCHER_RATIO) }, // ramp up
        { duration: "1m", target: Math.round(CONCURRENCY * WATCHER_RATIO) }, // maintain
        { duration: "30s", target: 0 }, // ramp down
      ],
      exec: "watcher",
    },
    updaters: {
      executor: "ramping-vus",
      stages: [
        {
          duration: "1m",
          target: CONCURRENCY - Math.round(CONCURRENCY * WATCHER_RATIO),
        }, // ramp up
        {
          duration: "1m",
          target: CONCURRENCY - Math.round(CONCURRENCY * WATCHER_RATIO),
        }, // maintain
        { duration: "30s", target: 0 }, // ramp down
      ],
      exec: "updater",
    },
  },
  setupTimeout: "30s",
  teardownTimeout: "30s",
};

const watchOpen = new Counter("watch_open");
const watchError = new Counter("watch_error");
const watchEventReceived = new Counter("watch_event_received");

const activeClients = new Counter("active_clients");
const activeClientsSuccessRate = new Rate("active_clients_success_rate");
const activeClientsTime = new Trend("active_clients_time", true);

const attachDocuments = new Counter("attach_documents");
const attachDocumentsSuccessRate = new Rate("attach_documents_success_rate");
const attachDocumentsTime = new Trend("attach_documents_time", true);

const pushpulls = new Counter("pushpulls");
const pushpullsSuccessRate = new Rate("pushpulls_success_rate");
const pushpullsTime = new Trend("pushpulls_time", true);

const deactivateClients = new Counter("deactivate_clients");
const deactivateClientsSuccessRate = new Rate(
  "deactivate_clients_success_rate"
);
const deactivateClientsTime = new Trend("deactivate_clients_time", true);

const watcherTransactionFaileds = new Counter("watcher_transaction_faileds");
const watcherTransactionSuccessRate = new Rate(
  "watcher_transaction_success_rate"
);
const watcherTransactionTime = new Trend("watcher_transaction_time", true); // true enables time formatting

const updaterTransactionFaileds = new Counter("updater_transaction_faileds");
const updaterTransactionSuccessRate = new Rate(
  "updater_transaction_success_rate"
);
const updaterTransactionTime = new Trend("updater_transaction_time", true); // true enables time formatting

function getDocKey() {
  if (TEST_MODE === "skew") return DOC_KEY_PREFIX;
  const cnt = CONCURRENCY / VU_PER_DOCS;
  return `${DOC_KEY_PREFIX}-${__VU % cnt}`;
}

function hexToBase64(hex: string) {
  const bytes = new Uint8Array(
    hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
  );
  return b64encode(bytes);
}

// Common headers that can be reused across requests
function getCommonHeaders() {
  return {
    Accept: "*/*",
    "Accept-Language": "ko,en-US;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    DNT: "1",
    Origin: "http://localhost:5173",
    Pragma: "no-cache",
    Referer: "http://localhost:5173/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "connect-protocol-version": "1",
    "content-type": "application/json",
    "sec-ch-ua":
      '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "x-api-key": API_KEY,
    "x-yorkie-user-agent": "@yorkie-js/sdk/0.6.12",
  };
}

// Helper function to make HTTP requests with common error handling
function makeRequest(url: string, payload: any, additionalHeaders = {}) {
  const headers = {
    ...getCommonHeaders(),
    ...additionalHeaders,
  };

  const params = { headers, timeout: "100s" };

  try {
    const response = http.post(url, JSON.stringify(payload), params);

    const success = check(response, {
      "status is 200": (r: any) => r.status === 200,
      "response has valid body": (r: any) => r.body && r.body.length > 0,
    });

    if (!success) {
      console.error(`Request failed: ${response.status} ${response.body}`);
      return null;
    }

    try {
      return JSON.parse(response.body);
    } catch (e: any) {
      console.error(`Error parsing response: ${e.message}`);
      return null;
    }
  } catch (e: any) {
    console.error(`Exception in request: ${e.message}`);
    return null;
  }
}

function activateClient() {
  const startTime = new Date().getTime();

  // Generate a random client key
  const clientKey = `${Math.random()
    .toString(36)
    .substring(2)}-${Date.now().toString(36)}`;

  const result = makeRequest(
    `${API_URL}/yorkie.v1.YorkieService/ActivateClient`,
    { clientKey },
    { "x-shard-key": `${API_KEY}/${clientKey}` }
  );

  const response = [result!.clientId, clientKey];

  const endTime = new Date().getTime();
  const duration = endTime - startTime;

  activeClients.add(1);
  activeClientsSuccessRate.add(true);
  activeClientsTime.add(duration);

  return response;
}

function deactivateClient(clientID: string, clientKey: string): string {
  const startTime = new Date().getTime();

  const result = makeRequest(
    `${API_URL}/yorkie.v1.YorkieService/DeactivateClient`,
    { clientId: clientID },
    { "x-shard-key": `${API_KEY}/${clientKey}` }
  );

  result!.clientId;

  const endTime = new Date().getTime();
  const duration = endTime - startTime;

  deactivateClients.add(1);
  deactivateClientsSuccessRate.add(true);
  deactivateClientsTime.add(duration);

  return clientID;
}

function attachDocument(clientID: string, actorID: string, docKey: string) {
  const startTime = new Date().getTime();

  // Generate a random color for presence data
  const colors = ["#00C9A7", "#C0392B", "#3498DB", "#F1C40F", "#9B59B6"];
  const randomColor = colors[Math.floor(Math.random() * colors.length)];

  const payload = {
    clientId: clientID,
    changePack: {
      documentKey: docKey,
      checkpoint: { clientSeq: 1 },
      changes: [
        {
          id: { clientSeq: 1, actorId: actorID, versionVector: {} },
          presenceChange: {
            type: "CHANGE_TYPE_PUT",
            presence: { data: { color: `"${randomColor}"` } },
          },
        },
      ],
      versionVector: {},
    },
  };

  const resp = makeRequest(
    `${API_URL}/yorkie.v1.YorkieService/AttachDocument`,
    payload,
    { "x-shard-key": `${API_KEY}/${docKey}` }
  );

  const documentId = resp!.documentId;
  const serverSeq = Number(resp!.changePack.checkpoint.serverSeq);

  const endTime = new Date().getTime();
  const duration = endTime - startTime;

  attachDocuments.add(1);
  attachDocumentsSuccessRate.add(true);
  attachDocumentsTime.add(duration);

  return [documentId, serverSeq];
}

function pushpullChanges(
  clientID: string,
  docID: string,
  docKey: string,
  lastServerSeq: number
): number {
  const start = Date.now();

  const payload = {
    clientId: clientID,
    documentId: docID,
    changePack: {
      documentKey: docKey,
      checkpoint: {
        clientSeq: 1,
        serverSeq: lastServerSeq,
      },
      versionVector: {},
    },
  };

  const resp = makeRequest(
    `${API_URL}/yorkie.v1.YorkieService/PushPullChanges`,
    payload,
    { "x-shard-key": `${API_KEY}/${docKey}` }
  );

  const serverSeq = Number(resp!.changePack.checkpoint.serverSeq);

  pushpulls.add(1);
  pushpullsSuccessRate.add(true);
  pushpullsTime.add(Date.now() - start);

  return serverSeq;
}

const PROTO_DIR = ["../../api"];
const PROTO_FILE = "yorkie/v1/yorkie.proto";
const GRPC_TARGET = "localhost:8080";

const gRPCClient = new Client();
gRPCClient.load(PROTO_DIR, PROTO_FILE);

// Watcher function to handle document watching
export function watcher() {
  const startTime = new Date().getTime();
  let success = false;
  const docKey = getDocKey();

  try {
    const [cid, cKey] = activateClient();
    const [docId] = attachDocument(cid, hexToBase64(cid), docKey);

    // Ensure the client activates and attaches the document before watching
    sleep(1);

    gRPCClient.connect(GRPC_TARGET, { plaintext: true });

    // Create a stream to watch the document
    const stream = new Stream(
      gRPCClient,
      "yorkie.v1.YorkieService/WatchDocument",
      {
        metadata: { "x-shard-key": `${API_KEY}/${docKey}` },
      }
    );

    // receive events from the stream
    stream.on("data", (msg) => {
      watchEventReceived.add(1);
    });

    // error handling for the stream
    stream.on("error", (e) => {
      watchError.add(1);
    });

    // send the initial watch request
    stream.write({ client_id: cid, document_id: docId });
    watchOpen.add(1);

    // keep alive the stream for a while to receive events
    sleep(5);

    stream.end();
    gRPCClient.close();

    deactivateClient(cid, cKey);

    success = true;
  } catch (e: any) {
    watcherTransactionFaileds.add(1);
  } finally {
    watcherTransactionSuccessRate.add(success);
    const endTime = new Date().getTime();
    watcherTransactionTime.add(endTime - startTime);
  }
}

// Updater function to handle document updates
export function updater() {
  const startTime = new Date().getTime();
  let success = false;
  const docKey = getDocKey();

  try {
    const [cid, cKey] = activateClient();
    const [docId, sSeq0] = attachDocument(cid, hexToBase64(cid), docKey);

    // Ensure the client activates and attaches the document before updating
    sleep(1);

    let sSeq = sSeq0;

    // Randomly push and pull changes to the document to emulate presence updates
    for (let i = 0; i < 10; i++) {
      sSeq = pushpullChanges(cid, docId, docKey, sSeq);
      sleep(0.5);
    }

    deactivateClient(cid, cKey);

    success = true;
  } catch (e: any) {
    updaterTransactionFaileds.add(1);
  } finally {
    updaterTransactionSuccessRate.add(success);
    const endTime = new Date().getTime();
    updaterTransactionTime.add(endTime - startTime);
  }
}
