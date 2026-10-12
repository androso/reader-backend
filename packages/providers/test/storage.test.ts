import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import { StoredBookFileNotFoundError } from "@reader/application";
import { ObjectStorageProvider } from "../src/storage";

const createProvider = (
    driver: string,
    directory?: string,
    client?: S3Client
) => {
    const previousDriver = process.env.STORAGE_DRIVER;
    const previousDirectory = process.env.LOCAL_STORAGE_DIR;
    try {
        process.env.STORAGE_DRIVER = driver;
        if (directory) process.env.LOCAL_STORAGE_DIR = directory;
        return new ObjectStorageProvider(client);
    } finally {
        if (previousDriver === undefined) delete process.env.STORAGE_DRIVER;
        else process.env.STORAGE_DRIVER = previousDriver;
        if (previousDirectory === undefined)
            delete process.env.LOCAL_STORAGE_DIR;
        else process.env.LOCAL_STORAGE_DIR = previousDirectory;
    }
};

test("local storage round-trips files and normalizes a missing original", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reader-storage-"));
    try {
        const provider = createProvider("local", directory);
        const key = "users/owner/books/book/original";
        const bytes = Buffer.from("synthetic book");
        await provider.uploadFile(key, bytes);
        assert.deepEqual(await provider.getFile(key), bytes);
        await assert.rejects(
            provider.getFile("missing-original"),
            StoredBookFileNotFoundError
        );
        await provider.deleteFile(key);
        await assert.rejects(
            provider.getFile(key),
            StoredBookFileNotFoundError
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("invalid local storage keys are not misclassified as missing files", async () => {
    const provider = createProvider(
        "local",
        path.join(tmpdir(), "reader-storage")
    );
    await assert.rejects(provider.getFile("../outside"), /Invalid storage key/);
});

test("S3 NoSuchKey is normalized without an external request", async () => {
    const missing = Object.assign(new Error("missing object"), {
        name: "NoSuchKey",
    });
    const client = {
        send: async () => {
            throw missing;
        },
    } as unknown as S3Client;
    const provider = createProvider("s3", undefined, client);
    await assert.rejects(
        provider.getFile("missing-original"),
        StoredBookFileNotFoundError
    );
});

test("S3 permission, bucket, and network failures are not reported as missing files", async () => {
    for (const name of ["AccessDenied", "NoSuchBucket", "NetworkingError"]) {
        const failure = Object.assign(new Error("storage unavailable"), {
            name,
        });
        const client = {
            send: async () => {
                throw failure;
            },
        } as unknown as S3Client;
        const provider = createProvider("s3", undefined, client);
        await assert.rejects(
            provider.getFile("original"),
            (error) => error === failure
        );
    }
});
