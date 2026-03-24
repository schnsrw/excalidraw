import {
  createDocumentTranslationPipeline,
  getDocumentFormat,
  type DocumentAdapter,
  type SupportedDocumentFormat,
  type TranslationClient,
  type WasmDocumentRuntime,
} from "../src";

describe("getDocumentFormat", () => {
  it("resolves supported formats", () => {
    expect(getDocumentFormat("proposal.DOCX")).toBe("docx");
    expect(getDocumentFormat("localization.odt")).toBe("odt");
    expect(getDocumentFormat("legacy.doc")).toBe("doc");
    expect(getDocumentFormat("report.pdf")).toBe("pdf");
  });

  it("returns null for unsupported formats", () => {
    expect(getDocumentFormat("slides.pptx")).toBeNull();
  });
});

describe("createDocumentTranslationPipeline", () => {
  const encodedText = new TextEncoder().encode("sample");

  const createAdapter = (format: SupportedDocumentFormat): DocumentAdapter => ({
    parse: async ({ bytes }) => ({
      format,
      binary: bytes,
      segments: [
        { id: "title", text: "Hello", path: "body/title" },
        { id: "body", text: "How are you?", path: "body/paragraph/0" },
      ],
    }),
    render: async ({ translatedSegments }) =>
      new TextEncoder().encode(
        JSON.stringify({
          title: translatedSegments.get("title"),
          body: translatedSegments.get("body"),
        }),
      ),
  });

  const runtime: WasmDocumentRuntime = {
    readDocument: async (_format, bytes) => bytes,
    writeDocument: async (_format, bytes) => bytes,
  };

  const translationClient: TranslationClient = {
    translate: async (segment, context) => ({
      translatedText: `${segment.text} (${context.targetLanguage})`,
    }),
  };

  const adapters = {
    docx: createAdapter("docx"),
    odt: createAdapter("odt"),
    doc: createAdapter("doc"),
    pdf: createAdapter("pdf"),
  };

  it("translates a supported document and preserves segment mapping", async () => {
    const pipeline = createDocumentTranslationPipeline({
      runtime,
      adapters,
      translationClient,
      maxParallelSegments: 2,
    });

    const translated = await pipeline.translateDocument({
      fileName: "contract.docx",
      bytes: encodedText,
      targetLanguage: "es",
    });

    expect(translated.format).toBe("docx");
    expect(translated.translatedSegments).toBe(2);

    const output = JSON.parse(new TextDecoder().decode(translated.translatedBytes));
    expect(output).toEqual({
      title: "Hello (es)",
      body: "How are you? (es)",
    });
  });

  it("throws on unsupported formats", async () => {
    const pipeline = createDocumentTranslationPipeline({
      runtime,
      adapters,
      translationClient,
    });

    await expect(
      pipeline.translateDocument({
        fileName: "deck.pptx",
        bytes: encodedText,
        targetLanguage: "fr",
      }),
    ).rejects.toThrow("Unsupported file format");
  });
});
