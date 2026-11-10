import { describe, expect, it } from "vitest";
import { classifyOutbound, OUTBOUND_MIME } from "@/lib/inbox/media";

/** Bytes mínimos com a assinatura do tipo; o resto é enchimento. */
const bytes = (head: number[], size = 64) => Buffer.concat([Buffer.from(head), Buffer.alloc(size)]);
const ascii = (text: string, offset = 0, size = 64) =>
  Buffer.concat([Buffer.alloc(offset), Buffer.from(text, "latin1"), Buffer.alloc(size)]);

const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0]);
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = ascii("%PDF-1.7\n");
const MP4 = ascii("ftypisom", 4);
const M4A = ascii("ftypM4A ", 4);
const GPP = ascii("ftyp3gp4", 4);
const OGG = ascii("OggS");
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("classifyOutbound: o tipo vem do conteúdo", () => {
  it("aceita imagem, vídeo, áudio, PDF e texto, com o tipo de mensagem certo", () => {
    expect(classifyOutbound(JPEG, "image/jpeg")).toEqual({ mime: "image/jpeg", kind: "image" });
    expect(classifyOutbound(PNG, "image/png")).toEqual({ mime: "image/png", kind: "image" });
    expect(classifyOutbound(ascii("RIFF\0\0\0\0WEBP"), null)).toEqual({ mime: "image/webp", kind: "image" });
    expect(classifyOutbound(MP4, "video/mp4")).toEqual({ mime: "video/mp4", kind: "video" });
    expect(classifyOutbound(GPP, "video/3gpp")).toEqual({ mime: "video/3gpp", kind: "video" });
    expect(classifyOutbound(OGG, "audio/ogg")).toEqual({ mime: "audio/ogg", kind: "audio" });
    expect(classifyOutbound(M4A, "audio/mp4")).toEqual({ mime: "audio/mp4", kind: "audio" });
    expect(classifyOutbound(ascii("#!AMR\n"), "audio/amr")).toEqual({ mime: "audio/amr", kind: "audio" });
    expect(classifyOutbound(PDF, "application/pdf")).toEqual({ mime: "application/pdf", kind: "document" });
    expect(classifyOutbound(Buffer.from("só texto"), "text/plain")).toEqual({
      mime: "text/plain",
      kind: "document",
    });
  });

  it("o tipo declarado não decide: HTML com cara de imagem é recusado", () => {
    expect(classifyOutbound(Buffer.from("<html><script>alert(1)</script></html>"), "image/png")).toBeNull();
    expect(classifyOutbound(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/jpeg")).toBeNull();
    expect(classifyOutbound(Buffer.from("MZ\x90\x00executavel"), "application/pdf")).toBeNull();
  });

  it("o conteúdo manda mesmo quando o declarado é de outra família", () => {
    // PDF declarado como PNG: segue como PDF (documento), nunca como imagem.
    expect(classifyOutbound(PDF, "image/png")).toEqual({ mime: "application/pdf", kind: "document" });
    // PNG declarado como PDF: segue como imagem.
    expect(classifyOutbound(PNG, "application/pdf")).toEqual({ mime: "image/png", kind: "image" });
  });

  it("fora da lista: GIF, WebM, CSV, ZIP solto, sem tipo", () => {
    expect(classifyOutbound(ascii("GIF89a"), "image/gif")).toBeNull();
    expect(classifyOutbound(bytes([0x1a, 0x45, 0xdf, 0xa3]), "video/webm")).toBeNull();
    expect(classifyOutbound(Buffer.from("a,b\n1,2\n"), "text/csv")).toBeNull();
    expect(classifyOutbound(bytes([0x50, 0x4b, 0x03, 0x04]), "application/zip")).toBeNull();
    expect(classifyOutbound(Buffer.from([1, 2, 3, 4]), "application/octet-stream")).toBeNull();
    expect(classifyOutbound(Buffer.from([1, 2, 3, 4]), null)).toBeNull();
  });

  it("texto com byte nulo não é texto", () => {
    expect(classifyOutbound(Buffer.from([0x61, 0x00, 0x62]), "text/plain")).toBeNull();
  });

  it("documento do Office precisa ter a pasta do formato dentro do ZIP", () => {
    const zip = (inside: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(inside), Buffer.alloc(32)]);

    expect(classifyOutbound(zip("word/document.xml"), DOCX_MIME)).toEqual({ mime: DOCX_MIME, kind: "document" });
    // ZIP qualquer com nome e tipo de .docx não passa.
    expect(classifyOutbound(zip("malware.exe"), DOCX_MIME)).toBeNull();
    expect(classifyOutbound(zip("word/document.xml"), "application/zip")).toBeNull();
  });

  it("a lista não tem tipo ativo (SVG, HTML, JavaScript)", () => {
    for (const mime of Object.keys(OUTBOUND_MIME)) {
      expect(mime).not.toMatch(/svg|html|javascript|xml$/);
    }
  });
});
