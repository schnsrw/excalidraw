import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  doc,
  getDoc,
  runTransaction,
  Bytes,
} from "firebase/firestore";
import { getStorage, ref, uploadBytes } from "firebase/storage";

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

import { FILE_CACHE_MAX_AGE_SEC } from "../app_constants";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// private
// -----------------------------------------------------------------------------

const STORAGE_DRIVER =
  (import.meta.env.VITE_APP_STORAGE_DRIVER as
    | "firebase"
    | "s3"
    | "redis"
    | undefined) || "firebase";

const S3_PUBLIC_URL = import.meta.env.VITE_APP_S3_PUBLIC_URL as string | undefined;
const S3_PRESIGN_URL = import.meta.env.VITE_APP_S3_PRESIGN_URL as
  | string
  | undefined;
const STORAGE_BASE_URL =
  (import.meta.env.VITE_APP_STORAGE_BASE_URL as string | undefined) || "/api";

let FIREBASE_CONFIG: Record<string, any>;
try {
  FIREBASE_CONFIG = JSON.parse(import.meta.env.VITE_APP_FIREBASE_CONFIG);
} catch (error: any) {
  console.warn(
    `Error JSON parsing firebase config. Supplied value: ${
      import.meta.env.VITE_APP_FIREBASE_CONFIG
    }`,
  );
  FIREBASE_CONFIG = {};
}

let firebaseApp: ReturnType<typeof initializeApp> | null = null;
let firestore: ReturnType<typeof getFirestore> | null = null;
let firebaseStorage: ReturnType<typeof getStorage> | null = null;

const _initializeFirebase = () => {
  if (!firebaseApp) {
    firebaseApp = initializeApp(FIREBASE_CONFIG);
  }
  return firebaseApp;
};

const _getFirestore = () => {
  if (!firestore) {
    firestore = getFirestore(_initializeFirebase());
  }
  return firestore;
};

const _getStorage = () => {
  if (!firebaseStorage) {
    firebaseStorage = getStorage(_initializeFirebase());
  }
  return firebaseStorage;
};

// -----------------------------------------------------------------------------

export const loadFirebaseStorage = async () => {
  return _getStorage();
};

type FirebaseStoredScene = {
  sceneVersion: number;
  iv: Bytes;
  ciphertext: Bytes;
};

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
  data: FirebaseStoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const ciphertext = data.ciphertext.toUint8Array();
  const iv = data.iv.toUint8Array();

  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    const chunk = bytes.subarray(i, i + 4096);
    binary += String.fromCharCode.apply(null, Array.from(chunk) as any);
  }
  return btoa(binary);
};

const base64ToBytes = (base64: string) => {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const createRedisSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
): Promise<RedisStoredScene> => {
  const sceneVersion = getSceneVersion(elements);
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  return {
    sceneVersion,
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
};

const decryptRedisScene = async (
  data: RedisStoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const ciphertext = base64ToBytes(data.ciphertext);
  const iv = base64ToBytes(data.iv);
  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

class FirebaseSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return FirebaseSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    FirebaseSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return FirebaseSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  if (STORAGE_DRIVER === "s3") {
    return await saveFilesToS3({ prefix, files });
  }
  if (STORAGE_DRIVER === "redis") {
    return await saveFilesToRedis({ prefix, files });
  }

  const storage = await loadFirebaseStorage();

  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const storageRef = ref(storage, `${prefix}/${id}`);
        await uploadBytes(storageRef, buffer, {
          cacheControl: `public, max-age=${FILE_CACHE_MAX_AGE_SEC}`,
        });
        savedFiles.push(id);
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

const createFirebaseSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
) => {
  const sceneVersion = getSceneVersion(elements);
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  return {
    sceneVersion,
    ciphertext: Bytes.fromUint8Array(new Uint8Array(ciphertext)),
    iv: Bytes.fromUint8Array(iv),
  } as FirebaseStoredScene;
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return null;
  }

  if (STORAGE_DRIVER === "redis") {
    const base = STORAGE_BASE_URL.replace(/\/$/, "");
    // Get existing scene (if any) and reconcile
    let prevStoredElements: SyncableExcalidrawElement[] | null = null;
    try {
      const resp = await fetch(`${base}/scenes/${roomId}`);
      if (resp.ok) {
        const storedScene = (await resp.json()) as RedisStoredScene;
        prevStoredElements = getSyncableElements(
          restoreElements(
            await decryptRedisScene(storedScene, roomKey),
            null,
          ),
        );
      }
    } catch {}

    let nextElements: readonly SyncableExcalidrawElement[] = elements;
    if (prevStoredElements) {
      nextElements = getSyncableElements(
        reconcileElements(
          elements,
          prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
          appState,
        ),
      );
    }

    const storedScene = await createRedisSceneDocument(nextElements, roomKey);
    await fetch(`${base}/scenes/${roomId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(storedScene),
    });

    const storedElements = getSyncableElements(
      restoreElements(await decryptRedisScene(storedScene, roomKey), null),
    );
    FirebaseSceneVersionCache.set(socket, storedElements);
    return storedElements;
  }

  const firestore = _getFirestore();
  const docRef = doc(firestore, "scenes", roomId);

  const storedScene = await runTransaction(firestore, async (transaction) => {
    const snapshot = await transaction.get(docRef);

    if (!snapshot.exists()) {
      const storedScene = await createFirebaseSceneDocument(elements, roomKey);

      transaction.set(docRef, storedScene);

      return storedScene;
    }

    const prevStoredScene = snapshot.data() as FirebaseStoredScene;
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

    const storedScene = await createFirebaseSceneDocument(
      reconciledElements,
      roomKey,
    );

    transaction.update(docRef, storedScene);

    // Return the stored elements as the in memory `reconciledElements` could have mutated in the meantime
    return storedScene;
  });

  const storedElements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null),
  );

  FirebaseSceneVersionCache.set(socket, storedElements);

  return storedElements;
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  if (STORAGE_DRIVER === "redis") {
    const base = STORAGE_BASE_URL.replace(/\/$/, "");
    const resp = await fetch(`${base}/scenes/${roomId}`);
    if (!resp.ok) return null;
    const storedScene = (await resp.json()) as RedisStoredScene;
    const elements = getSyncableElements(
      restoreElements(await decryptRedisScene(storedScene, roomKey), null, {
        deleteInvisibleElements: true,
      }),
    );
    if (socket) {
      FirebaseSceneVersionCache.set(socket, elements);
    }
    return elements;
  }
  const firestore = _getFirestore();
  const docRef = doc(firestore, "scenes", roomId);
  const docSnap = await getDoc(docRef);
  if (!docSnap.exists()) {
    return null;
  }
  const storedScene = docSnap.data() as FirebaseStoredScene;
  const elements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null, {
      deleteInvisibleElements: true,
    }),
  );

  if (socket) {
    FirebaseSceneVersionCache.set(socket, elements);
  }

  return elements;
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  if (STORAGE_DRIVER === "s3") {
    return await loadFilesFromS3(prefix, decryptionKey, filesIds);
  }
  if (STORAGE_DRIVER === "redis") {
    return await loadFilesFromRedis(prefix, decryptionKey, filesIds);
  }
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const url = `https://firebasestorage.googleapis.com/v0/b/${
          FIREBASE_CONFIG.storageBucket
        }/o/${encodeURIComponent(prefix.replace(/^\//, ""))}%2F${id}`;
        const response = await fetch(`${url}?alt=media`);
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
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
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};

// S3/MinIO implementation (self-hosted)
// -----------------------------------------------------------------------------

const ensureS3Env = () => {
  if (!S3_PUBLIC_URL) {
    throw new Error(
      "VITE_APP_S3_PUBLIC_URL is required when VITE_APP_STORAGE_DRIVER=s3",
    );
  }
  if (!S3_PRESIGN_URL) {
    throw new Error(
      "VITE_APP_S3_PRESIGN_URL is required when VITE_APP_STORAGE_DRIVER=s3",
    );
  }
};

const saveFilesToS3 = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  ensureS3Env();
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const key = `${prefix.replace(/^\//, "")}/${id}`;
        const params = new URLSearchParams({
          key,
          contentType: "application/octet-stream",
          cacheControl: `public, max-age=${FILE_CACHE_MAX_AGE_SEC}`,
        });
        const presignResp = await fetch(`${S3_PRESIGN_URL}?${params.toString()}`, {
          method: "GET",
        });
        if (!presignResp.ok) {
          throw new Error("Failed to obtain S3 presigned URL");
        }
        const { url } = (await presignResp.json()) as { url: string };
        const putResp = await fetch(url, {
          method: "PUT",
          body: buffer,
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": `public, max-age=${FILE_CACHE_MAX_AGE_SEC}`,
          },
        });
        if (!putResp.ok) {
          throw new Error("Failed to upload to S3 presigned URL");
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

const loadFilesFromS3 = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  ensureS3Env();
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const key = `${prefix.replace(/^\//, "")}/${id}`;
        const url = `${S3_PUBLIC_URL!.replace(/\/$/, "")}/${key}`;
        const response = await fetch(url);
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
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
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};

// Redis-backed storage API implementation (self-hosted)
// -----------------------------------------------------------------------------

const saveFilesToRedis = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  const base = STORAGE_BASE_URL!.replace(/\/$/, "");

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const key = `${prefix.replace(/^\//, "")}/${id}`;
        const url = `${base}/files/${key}`;
        const putResp = await fetch(url, {
          method: "PUT",
          body: buffer,
          headers: {
            "Content-Type": "application/octet-stream",
            // short cache aligned with storage TTL by default; server can override
            "Cache-Control": `public, max-age=86400`,
          },
        });
        if (!putResp.ok) {
          throw new Error("Failed to upload to Redis storage API");
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

const loadFilesFromRedis = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  const base = STORAGE_BASE_URL!.replace(/\/$/, "");

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const key = `${prefix.replace(/^\//, "")}/${id}`;
        const url = `${base}/files/${key}`;
        const response = await fetch(url);
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
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
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
