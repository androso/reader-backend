import { useEffect, useRef, useState } from "react";
import JSZip from "jszip";

interface ImageResource {
    originalPath: string;
    blobUrl: string;
}

export const useImageLoader = (zipData: JSZip | null, basePath: string) => {
    const [imageResources, setImageResources] = useState<
        Record<string, ImageResource>
    >({});
    const objectUrls = useRef(new Set<string>());

    useEffect(() => {
        setImageResources({});
        return () => {
            for (const url of objectUrls.current) URL.revokeObjectURL(url);
            objectUrls.current.clear();
        };
    }, [zipData]);

    const createImageDataUrl = async (imagePath: string): Promise<string> => {
        if (!zipData) return "";
        const imageFile =
            zipData.file(imagePath) || zipData.file(`${basePath}${imagePath}`);

        if (!imageFile) {
            throw new Error(`Image file not found: ${imagePath}`);
        }
        const arrayBuffer = await imageFile.async("arraybuffer");
        const extension = imagePath.split(".").pop()?.toLowerCase();
        const mimeType =
            extension === "jpg" || extension === "jpeg"
                ? "image/jpeg"
                : extension === "png"
                  ? "image/png"
                  : "image/gif";

        const blob = new Blob([arrayBuffer], { type: mimeType });
        const url = URL.createObjectURL(blob);
        objectUrls.current.add(url);
        if (!url) {
            console.log("no url found!!!");
        }
        return url;
    };

    const loadImage = async (originalPath: string): Promise<string> => {
        if (imageResources[originalPath]) {
            return imageResources[originalPath].blobUrl;
        }

        const dataUrl = await createImageDataUrl(originalPath);
        setImageResources((prev) => ({
            ...prev,
            [originalPath]: { originalPath, blobUrl: dataUrl },
        }));
        return dataUrl;
    };

    return { loadImage, imageResources };
};
