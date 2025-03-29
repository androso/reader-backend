import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export const resolveRelativePath = (
    relativePath: string,
    basePath: string
): string => {
    const cleanRelativePath = relativePath.replace(/^\//, "");
    const basePathParts = basePath.split("/").filter(Boolean);
    const relativePathParts = cleanRelativePath.split("/");
    const resolvedParts: string[] = [...basePathParts];

    for (const part of relativePathParts) {
        if (part === "..") {
            resolvedParts.pop();
        } else if (part !== ".") {
            resolvedParts.push(part);
        }
    }

    return resolvedParts.join("/");
};
