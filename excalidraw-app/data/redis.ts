import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";
import { createClient } from "redis";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// -----------------------------------------------------------------------------

const TTL_SECONDS = 60 * 60 * 24; // 24 hours

let redisClient: ReturnType<typeof createClient> | null = null;
const memoryStore = new Map<string, { value: Uint8Array | string; expires: number }>();

const getRedisClient = async () => {
  const url = import.meta.env.VITE_APP_REDIS_URL;
  if (!url) {
    return null;
  }
  if (!redisClient) {
    redisClient = createClient({ url });
    redisClient.on("error", (err) => console.error("Redis error", err));
    try {
      await redisClient.connect();
    } catch (err) {
      console.warn("Redis connection failed, falling back to memory store");
      redisClient = null;
    }
  }
  return redisClient;
};

// -----------------------------------------------------------------------------

type RedisStoredScene = {
  sceneVersion: number;
  iv: string; // base64
  ciphertext: string; // base64
};

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);

  return { ciphertext: encryptedBuffer, iv };
};

const decryptElements = async (
  data: RedisStoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const ciphertext = Uint8Array.from(
    Buffer.from(data.ciphertext, "base64"),
  );
  const iv = Uint8Array.from(Buffer.from(data.iv, "base64"));

  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

class RedisSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return RedisSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    RedisSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToRedis = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return RedisSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  return true;
};

export const saveFilesToRedis = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const key = `${prefix}/${id}`;
        const client = await getRedisClient();
        if (client) {
          await client.set(Buffer.from(key), buffer, { EX: TTL_SECONDS });
        } else {
          memoryStore.set(key, { value: buffer, expires: Date.now() + TTL_SECONDS * 1000 });
        }
        savedFiles.push(id);
      } catch (error: any) {
        console.error(error);
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

const createRedisSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
): Promise<RedisStoredScene> => {
  const sceneVersion = getSceneVersion(elements);
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  return {
    sceneVersion,
    ciphertext: Buffer.from(ciphertext).toString("base64"),
    iv: Buffer.from(iv).toString("base64"),
  };
};

export const saveToRedis = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (!roomId || !roomKey || !socket || isSavedToRedis(portal, elements)) {
    return null;
  }

  const key = `scenes:${roomId}`;
  const client = await getRedisClient();
  const prevRaw = client
    ? await client.get(key)
    : (memoryStore.get(key)?.value as string | undefined);
  let storedScene: RedisStoredScene;

  if (!prevRaw) {
    storedScene = await createRedisSceneDocument(elements, roomKey);
  } else {
    const prevStoredScene = JSON.parse(prevRaw) as RedisStoredScene;
    const prevStoredElements = getSyncableElements(
      restoreElements(await decryptElements(prevStoredScene, roomKey), null),
    );
    const reconciledElements = getSyncableElements(
      reconcileElements(
        elements,
        prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
        appState,
      ),
    );
    storedScene = await createRedisSceneDocument(
      reconciledElements,
      roomKey,
    );
  }

  if (client) {
    await client.set(key, JSON.stringify(storedScene), { EX: TTL_SECONDS });
  } else {
    memoryStore.set(key, {
      value: JSON.stringify(storedScene),
      expires: Date.now() + TTL_SECONDS * 1000,
    });
  }

  const storedElements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null),
  );

  RedisSceneVersionCache.set(socket, storedElements);

  return storedElements;
};

export const loadFromRedis = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const key = `scenes:${roomId}`;
  const client = await getRedisClient();
  let raw: string | undefined;
  if (client) {
    raw = await client.get(key);
  } else {
    const entry = memoryStore.get(key);
    if (entry && entry.expires > Date.now()) {
      raw = entry.value as string;
    } else {
      memoryStore.delete(key);
    }
  }
  if (!raw) {
    return null;
  }
  const storedScene = JSON.parse(raw) as RedisStoredScene;
  const elements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null, {
      deleteInvisibleElements: true,
    }),
  );

  if (socket) {
    RedisSceneVersionCache.set(socket, elements);
  }

  return elements;
};

export const loadFilesFromRedis = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const key = `${prefix}/${id}`;
        const client = await getRedisClient();
        let buffer: Uint8Array | undefined;
        if (client) {
          buffer = await client.getBuffer(Buffer.from(key));
        } else {
          const entry = memoryStore.get(key);
          if (entry && entry.expires > Date.now()) {
            buffer = entry.value as Uint8Array;
          } else {
            memoryStore.delete(key);
          }
        }
        if (buffer) {
          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(buffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        console.error(error);
        erroredFiles.set(id, true);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};

