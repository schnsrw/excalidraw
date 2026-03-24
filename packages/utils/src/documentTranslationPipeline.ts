export type SupportedDocumentFormat = "docx" | "odt" | "doc" | "pdf";

export type TranslationSegment = {
  id: string;
  text: string;
  path: string;
  metadata?: Record<string, unknown>;
};

export type TranslationResult = {
  translatedText: string;
  detectedSourceLanguage?: string;
};

export type TranslationCallContext = {
  sourceLanguage?: string;
  targetLanguage: string;
  signal?: AbortSignal;
};

export type StructuredDocument = {
  format: SupportedDocumentFormat;
  binary: Uint8Array;
  segments: TranslationSegment[];
  manifest?: Record<string, unknown>;
};

export type ParseDocumentInput = {
  bytes: Uint8Array;
  signal?: AbortSignal;
};

export type RenderDocumentInput = {
  sourceBytes: Uint8Array;
  translatedSegments: Map<string, string>;
  structuredDocument: StructuredDocument;
  signal?: AbortSignal;
};

export type DocumentAdapter = {
  parse(input: ParseDocumentInput): Promise<StructuredDocument>;
  render(input: RenderDocumentInput): Promise<Uint8Array>;
};

export type WasmDocumentRuntime = {
  readDocument(
    format: SupportedDocumentFormat,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  writeDocument(
    format: SupportedDocumentFormat,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
};

export type TranslationClient = {
  translate(
    segment: TranslationSegment,
    context: TranslationCallContext,
  ): Promise<TranslationResult>;
};

export type TranslationPipelineOptions = {
  runtime: WasmDocumentRuntime;
  adapters: Record<SupportedDocumentFormat, DocumentAdapter>;
  translationClient: TranslationClient;
  maxParallelSegments?: number;
};

export type TranslateDocumentInput = {
  fileName: string;
  bytes: Uint8Array;
  targetLanguage: string;
  sourceLanguage?: string;
  signal?: AbortSignal;
};

export type TranslateDocumentOutput = {
  format: SupportedDocumentFormat;
  translatedBytes: Uint8Array;
  translatedSegments: number;
};

const DEFAULT_MAX_PARALLEL_SEGMENTS = 5;

const FORMAT_BY_EXTENSION: Record<string, SupportedDocumentFormat> = {
  ".docx": "docx",
  ".odt": "odt",
  ".doc": "doc",
  ".pdf": "pdf",
};

const normalizeFileName = (fileName: string) => fileName.trim().toLowerCase();

export const getDocumentFormat = (
  fileName: string,
): SupportedDocumentFormat | null => {
  const normalizedName = normalizeFileName(fileName);
  const ext = Object.keys(FORMAT_BY_EXTENSION).find((candidate) =>
    normalizedName.endsWith(candidate),
  );
  return ext ? FORMAT_BY_EXTENSION[ext] : null;
};

const assertAbortNotRequested = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new DOMException("Translation request was aborted", "AbortError");
  }
};

const createSegmentTranslationQueue = async (
  segments: TranslationSegment[],
  runTask: (segment: TranslationSegment) => Promise<void>,
  concurrency: number,
) => {
  const workers = Array.from({ length: Math.min(concurrency, segments.length) });
  let index = 0;

  await Promise.all(
    workers.map(async () => {
      while (index < segments.length) {
        const nextIndex = index;
        index += 1;
        await runTask(segments[nextIndex]);
      }
    }),
  );
};

export const createDocumentTranslationPipeline = (
  options: TranslationPipelineOptions,
) => {
  const maxParallelSegments =
    options.maxParallelSegments ?? DEFAULT_MAX_PARALLEL_SEGMENTS;

  return {
    async translateDocument(
      input: TranslateDocumentInput,
    ): Promise<TranslateDocumentOutput> {
      assertAbortNotRequested(input.signal);

      const format = getDocumentFormat(input.fileName);

      if (!format) {
        throw new Error(
          `Unsupported file format for ${input.fileName}. Supported formats are: docx, odt, doc, pdf`,
        );
      }

      const adapter = options.adapters[format];
      const wasmReadable = await options.runtime.readDocument(
        format,
        input.bytes,
        input.signal,
      );

      const structuredDocument = await adapter.parse({
        bytes: wasmReadable,
        signal: input.signal,
      });

      const translatedSegments = new Map<string, string>();

      await createSegmentTranslationQueue(
        structuredDocument.segments,
        async (segment) => {
          assertAbortNotRequested(input.signal);
          const result = await options.translationClient.translate(segment, {
            sourceLanguage: input.sourceLanguage,
            targetLanguage: input.targetLanguage,
            signal: input.signal,
          });
          translatedSegments.set(segment.id, result.translatedText);
        },
        maxParallelSegments,
      );

      const renderedDocument = await adapter.render({
        sourceBytes: wasmReadable,
        translatedSegments,
        structuredDocument,
        signal: input.signal,
      });

      const wasmWritable = await options.runtime.writeDocument(
        format,
        renderedDocument,
        input.signal,
      );

      return {
        format,
        translatedBytes: wasmWritable,
        translatedSegments: translatedSegments.size,
      };
    },
  };
};
