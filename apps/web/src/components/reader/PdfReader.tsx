"use client";

import React, { memo, useEffect, useState } from "react";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";

interface PdfReaderProps {
    url: string;
}

const PdfReader: React.FC<PdfReaderProps> = memo(({ url }) => {
    const [pdfUrl, setPdfUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let objectUrl: string | null = null;
        let cancelled = false;

        const loadPdf = async () => {
            try {
                setError(null);
                setPdfUrl(null);

                const response = await fetch(url, {
                    credentials: "include",
                });

                if (!response.ok) {
                    throw new Error(`Failed to fetch PDF: ${response.status}`);
                }

                const blob = await response.blob();
                objectUrl = URL.createObjectURL(
                    blob.type === "application/pdf"
                        ? blob
                        : new Blob([blob], { type: "application/pdf" })
                );

                if (cancelled) {
                    URL.revokeObjectURL(objectUrl);
                    return;
                }

                setPdfUrl(objectUrl);
            } catch (err) {
                if (!cancelled) {
                    setError(
                        err instanceof Error
                            ? err.message
                            : "Failed to load PDF"
                    );
                }
            }
        };

        loadPdf();

        return () => {
            cancelled = true;
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [url]);

    if (error) {
        return <div className="p-4 text-red-600">{error}</div>;
    }

    if (!pdfUrl) {
        return <LoadingSpinner />;
    }

    return (
        <div className="h-full bg-neutral-100">
            <iframe
                src={pdfUrl}
                title="PDF reader"
                className="h-full w-full border-0"
            />
        </div>
    );
});

PdfReader.displayName = "PdfReader";

export default PdfReader;
