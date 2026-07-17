import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RagEvalFixture } from "./types";

const FIXTURE_DIR = path.resolve(__dirname, "../fixtures");
const MANIFEST_PATH = path.join(FIXTURE_DIR, "manifest.json");

const requiredString = (
    value: unknown,
    field: keyof RagEvalFixture,
    index: number
) => {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Fixture manifest entry ${index + 1} requires ${field}`);
    }
    return value;
};

export const loadFixtureManifest = async (
    manifestPath = MANIFEST_PATH
): Promise<RagEvalFixture[]> => {
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
    if (!Array.isArray(parsed) || !parsed.length) {
        throw new Error("Fixture manifest must be a non-empty array");
    }

    const ids = new Set<string>();
    return parsed.map((value, index) => {
        if (!value || typeof value !== "object") {
            throw new Error(
                `Fixture manifest entry ${index + 1} must be an object`
            );
        }
        const entry = value as Record<string, unknown>;
        const fixture: RagEvalFixture = {
            id: requiredString(entry.id, "id", index),
            fileName: requiredString(entry.fileName, "fileName", index),
            title: requiredString(entry.title, "title", index),
            author: requiredString(entry.author, "author", index),
            downloadUrl: requiredString(
                entry.downloadUrl,
                "downloadUrl",
                index
            ),
            sourceRepository: requiredString(
                entry.sourceRepository,
                "sourceRepository",
                index
            ),
            sourceRevision: requiredString(
                entry.sourceRevision,
                "sourceRevision",
                index
            ),
            sha256: requiredString(entry.sha256, "sha256", index),
            sizeBytes: Number(entry.sizeBytes),
        };
        if (
            !Number.isSafeInteger(fixture.sizeBytes) ||
            fixture.sizeBytes <= 0
        ) {
            throw new Error(
                `Fixture manifest entry ${index + 1} requires sizeBytes`
            );
        }
        if (ids.has(fixture.id)) {
            throw new Error(`Duplicate fixture id: ${fixture.id}`);
        }
        ids.add(fixture.id);
        return fixture;
    });
};

export const getFixture = (
    fixtures: RagEvalFixture[],
    fixtureId: string
) => {
    const fixture = fixtures.find((candidate) => candidate.id === fixtureId);
    if (!fixture) throw new Error(`Unknown fixture: ${fixtureId}`);
    return fixture;
};

export const verifyFixture = async (
    fixture: RagEvalFixture,
    fixtureDir = FIXTURE_DIR
) => {
    const filePath = path.join(fixtureDir, fixture.fileName);
    const buffer = await fs.readFile(filePath);
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    if (sha256 !== fixture.sha256) {
        throw new Error(
            `${fixture.id} checksum mismatch: expected ${fixture.sha256}, received ${sha256}`
        );
    }
    if (buffer.length !== fixture.sizeBytes) {
        throw new Error(
            `${fixture.id} size mismatch: expected ${fixture.sizeBytes}, received ${buffer.length}`
        );
    }
    return { buffer, filePath };
};
