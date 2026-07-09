"use client";
import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth";
import toast from "react-hot-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AuthProtection } from "@/components/AuthProtection";
import BookCover from "@/components/BookCover";
import type { Book } from "@/types/bookTypes";

function formatRelativeDate(date: Date | string): string {
    const d = new Date(date);
    const now = new Date();
    const diffDays = Math.floor(
        (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (diffDays === 0) return "Added today";
    if (diffDays === 1) return "Added yesterday";
    if (diffDays < 7) return `Added ${diffDays} days ago`;
    if (diffDays < 14) return "Added last week";
    if (diffDays < 30) return `Added ${Math.floor(diffDays / 7)} weeks ago`;
    if (diffDays < 60) return "Added last month";
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `Added ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function Home() {
    const router = useRouter();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [filter, setFilter] = useState<"all" | "epub" | "pdf">("all");

    const { data: booksData } = useQuery({
        queryKey: [`${process.env.NEXT_PUBLIC_API_URL}/api/books`],
        queryFn: async () => {
            const token = localStorage.getItem("token");
            const response = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/books`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            if (!response.ok) throw new Error("Network response was not ok");
            return response.json();
        },
    });

    const queryClient = useQueryClient();

    const { mutate: uploadFile } = useMutation({
        mutationFn: async (file: File) => {
            const formData = new FormData();
            formData.append("file", file);
            const token = localStorage.getItem("token");
            const response = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/books`,
                {
                    headers: { Authorization: `Bearer ${token}` },
                    method: "POST",
                    body: formData,
                }
            );
            if (!response.ok) throw new Error("Failed to upload file");
            return response.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: [`${process.env.NEXT_PUBLIC_API_URL}/api/books`],
            });
            toast.success("File uploaded successfully");
        },
        onError: () => toast.error("Failed to upload file"),
    });

    const { mutate: deleteItem } = useMutation({
        mutationFn: async (itemId: string) => {
            const token = localStorage.getItem("token");
            const response = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/books/${itemId}`,
                { headers: { Authorization: `Bearer ${token}` }, method: "DELETE" }
            );
            if (!response.ok) throw new Error("Failed deleting file");
            return response;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: [`${process.env.NEXT_PUBLIC_API_URL}/api/books`],
            });
            toast.success("Book deleted successfully");
        },
        onError: (err) => toast.error(err.message),
    });

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const validExtensions = [".epub", ".pdf"];
        if (!validExtensions.some((ext) => file.name.toLowerCase().endsWith(ext))) {
            toast.error("Please upload an EPUB or PDF file");
            return;
        }
        setIsUploading(true);
        uploadFile(file, { onSettled: () => setIsUploading(false) });
        e.target.value = "";
    };

    const allBooks: Book[] = booksData?.books ?? [];
    const sortedBooks = [...allBooks].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const recentBook = sortedBooks[0] ?? null;
    const filteredBooks =
        filter === "all"
            ? sortedBooks
            : sortedBooks.filter((b) => b.fileType === filter);

    const handleBookClick = (book: Book) => {
        router.push(`/read/${book.id}?type=${book.fileType ?? ""}`);
    };

    const navLinkClass = (active: boolean) =>
        `flex items-center gap-3 py-2 w-full text-left rounded-lg text-xs transition-colors group ${
            active
                ? "text-on-primary font-semibold"
                : "text-on-primary-container/70 hover:text-on-primary"
        }`;

    return (
        <div className="bg-background text-on-background min-h-screen flex flex-col md:flex-row overflow-hidden">
            {/* Mobile Top Nav */}
            <nav className="md:hidden flex items-center justify-between w-full px-10 py-4 bg-background z-20 sticky top-0 border-b border-surface-container-highest">
                <div className="text-2xl font-bold text-primary">Mentarie</div>
                <button className="text-on-surface-variant hover:text-on-surface transition-colors">
                    <span className="material-symbols-outlined">menu</span>
                </button>
            </nav>

            {/* Desktop Sidebar */}
            <aside className="hidden md:flex flex-col w-[280px] h-screen bg-primary-container z-20 shrink-0 p-8 fixed left-0 top-0 border-r border-white/10">
                <div className="mb-12">
                    <h1 className="text-3xl font-bold text-on-primary tracking-tight mb-1">
                        Mentarie
                    </h1>
                    <p className="text-xs text-on-primary-container uppercase tracking-wider opacity-80">
                        Academic Assistant
                    </p>
                </div>
                <nav className="flex-1 space-y-2">
                    <div className="space-y-6">
                        <div className="space-y-1">
                            <button
                                onClick={() => setFilter("all")}
                                className="flex items-center gap-3 px-4 py-3 w-full text-left rounded-lg bg-white/20 text-on-primary font-semibold text-sm transition-all"
                            >
                                <span
                                    className="material-symbols-outlined"
                                    style={{ fontVariationSettings: "'FILL' 1" }}
                                >
                                    library_books
                                </span>
                                Library
                            </button>
                            <div className="pl-11 space-y-1 mt-1">
                                <button
                                    onClick={() => setFilter("epub")}
                                    className={navLinkClass(filter === "epub")}
                                >
                                    <span className="material-symbols-outlined text-lg opacity-70 group-hover:opacity-100">
                                        description
                                    </span>
                                    Epubs
                                </button>
                                <button
                                    onClick={() => setFilter("pdf")}
                                    className={navLinkClass(filter === "pdf")}
                                >
                                    <span className="material-symbols-outlined text-lg opacity-70 group-hover:opacity-100">
                                        picture_as_pdf
                                    </span>
                                    PDFs
                                </button>
                            </div>
                        </div>
                    </div>
                </nav>
            </aside>

            {/* Main Content */}
            <main className="flex-1 md:ml-[280px] bg-background h-screen overflow-y-auto pb-24 md:pb-0 pl-3">
                {/* Header */}
                <header className="px-10 py-8 flex items-center justify-between sticky top-0 z-10 bg-background/80 backdrop-blur-md">
                    <div>
                        <h2 className="text-3xl font-bold text-on-background">Library</h2>
                        <p className="text-sm font-semibold text-on-surface-variant mt-1">
                            Your academic repository.
                        </p>
                    </div>
                    <div className="flex items-center gap-4">
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".epub,.pdf"
                            onChange={handleFileChange}
                            className="hidden"
                        />
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isUploading}
                            className="glass-panel text-sm font-semibold text-on-surface px-6 py-2.5 rounded-full flex items-center gap-2 hover:bg-surface-container transition-colors disabled:opacity-60"
                        >
                            <span className="material-symbols-outlined text-lg">upload</span>
                            {isUploading ? "Uploading..." : "Upload File"}
                        </button>
                        <button
                            onClick={() => {
                                signOut();
                                router.push("/login");
                            }}
                            className="bg-error text-on-error text-sm font-semibold px-6 py-2.5 rounded-full hover:bg-error-container hover:text-on-error-container transition-colors shadow-sm"
                        >
                            Logout
                        </button>
                    </div>
                </header>

                <div className="px-10 pb-12">
                    {/* Recent Activity */}
                    {recentBook && filter === "all" && (
                        <section className="mb-12">
                            <h3 className="text-2xl font-semibold text-on-surface mb-6 flex items-center gap-2">
                                <span className="material-symbols-outlined text-primary">
                                    schedule
                                </span>
                                Recent Activity
                            </h3>
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                <div
                                    onClick={() => handleBookClick(recentBook)}
                                    className="glass-panel p-6 rounded-xl flex gap-6 items-start group cursor-pointer relative overflow-hidden"
                                >
                                    <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                                    <BookCover
                                        book={recentBook}
                                        className="h-32 w-24 shrink-0 rounded-lg book-cover"
                                    />
                                    <div className="flex-1 relative z-10">
                                        <span className="text-xs font-semibold text-primary uppercase tracking-wider mb-2 inline-block">
                                            Recently Added
                                        </span>
                                        <h4 className="text-xl font-semibold text-on-surface mb-2 leading-tight">
                                            {recentBook.title}
                                        </h4>
                                        <div className="mt-4 flex items-center gap-4">
                                            <span className="bg-surface-container-high px-3 py-1 rounded-full text-xs font-semibold text-on-surface">
                                                .{recentBook.fileType ?? "epub"}
                                            </span>
                                            <span className="text-xs font-semibold text-on-surface-variant flex items-center gap-1">
                                                <span
                                                    className="material-symbols-outlined"
                                                    style={{ fontSize: "14px" }}
                                                >
                                                    calendar_today
                                                </span>
                                                {formatRelativeDate(recentBook.createdAt)}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </section>
                    )}

                    {/* All Documents */}
                    <section>
                        <div className="flex items-center justify-between mb-6">
                            <h3 className="text-2xl font-semibold text-on-surface flex items-center gap-2">
                                <span className="material-symbols-outlined text-primary">
                                    folder_open
                                </span>
                                {filter === "all"
                                    ? "All Documents"
                                    : filter === "epub"
                                    ? "Epubs"
                                    : "PDFs"}
                            </h3>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setFilter("all")}
                                    className={`p-2 rounded-full transition-colors ${
                                        filter === "all"
                                            ? "bg-surface-container text-on-surface"
                                            : "hover:bg-surface-container text-on-surface-variant opacity-50"
                                    }`}
                                    title="All documents"
                                >
                                    <span className="material-symbols-outlined text-xl">
                                        grid_view
                                    </span>
                                </button>
                            </div>
                        </div>

                        {filteredBooks.length === 0 ? (
                            <div className="text-center py-16 text-on-surface-variant">
                                <span className="material-symbols-outlined text-5xl mb-4 block opacity-40">
                                    library_books
                                </span>
                                <p className="text-sm font-semibold">
                                    {filter === "all"
                                        ? "No documents yet. Upload your first file!"
                                        : `No ${filter.toUpperCase()} files found.`}
                                </p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                                {filteredBooks.map((book) => (
                                    <div
                                        key={book.id}
                                        onClick={() => handleBookClick(book)}
                                        className="bg-surface rounded-xl p-4 border border-surface-container-highest hover:border-outline-variant transition-colors group cursor-pointer flex gap-4 h-52 book-cover"
                                    >
                                        <BookCover
                                            book={book}
                                            className="h-full w-28 shrink-0 rounded-lg"
                                            iconClassName="text-3xl"
                                        />
                                        <div className="flex min-w-0 flex-1 flex-col justify-between">
                                            <div>
                                                <div className="flex justify-between items-start mb-3 gap-2">
                                                    <span
                                                        className={`px-2.5 py-1 rounded text-xs font-semibold tracking-wide uppercase ${
                                                            book.fileType === "epub"
                                                                ? "bg-primary/10 text-primary"
                                                                : "bg-secondary/10 text-secondary"
                                                        }`}
                                                    >
                                                        .{book.fileType ?? "epub"}
                                                    </span>
                                                    <button
                                                        className="text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity hover:text-error"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            deleteItem(book.id);
                                                        }}
                                                        title="Delete"
                                                    >
                                                        <span className="material-symbols-outlined text-lg">
                                                            delete
                                                        </span>
                                                    </button>
                                                </div>
                                                <h4 className="text-base font-semibold text-on-surface line-clamp-3 leading-snug">
                                                    {book.title}
                                                </h4>
                                            </div>
                                            <div className="flex items-center gap-2 mt-4 text-on-surface-variant">
                                                <span
                                                    className="material-symbols-outlined"
                                                    style={{ fontSize: "16px" }}
                                                >
                                                    calendar_today
                                                </span>
                                                <span className="text-xs font-semibold">
                                                    {formatRelativeDate(book.createdAt)}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>
                </div>
            </main>
        </div>
    );
}

export default function Page() {
    return (
        <AuthProtection>
            <Home />
        </AuthProtection>
    );
}
