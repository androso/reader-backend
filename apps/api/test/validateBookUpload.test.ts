import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { validateBookUpload } from "../src/utils/validateBookUpload";

test("detects PDF by signature", async () => {
    assert.equal(await validateBookUpload(Buffer.from("%PDF-1.7\n")), "pdf");
});

test("accepts an EPUB container regardless of submitted MIME", async () => {
    const zip = new JSZip();
    zip.file("META-INF/container.xml", "<container />");
    assert.equal(
        await validateBookUpload(
            await zip.generateAsync({ type: "nodebuffer" })
        ),
        "epub"
    );
});

test("rejects arbitrary ZIP files", async () => {
    const zip = new JSZip();
    zip.file("file.txt", "not an epub");
    await assert.rejects(
        validateBookUpload(await zip.generateAsync({ type: "nodebuffer" })),
        /not an EPUB/
    );
});
