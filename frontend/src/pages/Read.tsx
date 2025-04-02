import { useLocation, useParams } from "wouter";
import { useWindowSize } from "../hooks/useWindowSize";
import { ChatInterface } from "../components/reader/ChatInterface";
import EpubReader from "../components/reader/EpubReader";

export default function Read() {
    const params = useParams();
    const bookFileKey = params.id as string | null;
    const { width } = useWindowSize();
    const isMobile = width < 768;
    const [location] = useLocation();
    const searchParams = new URLSearchParams(location.split("?")[1]);
    const bookId = searchParams.get("bookId");

    return (
        <div className="h-[100dvh] bg-[#D7D7D7] ">
            <div
                className={`h-[100dvh] w-full rounded-lg relative flex justify-center ${!isMobile && "p-8"}`}
            >
                {!isMobile && (
                    <div className="w-[40%] bg-[#FCFCFC] mr-4 rounded-lg">
                        <ChatInterface isMobile={false} bookId={bookId ?? ""} />
                    </div>
                )}
                {isMobile ? (
                    <div
                        className={`w-full relative overflow-hidden bg-[#FCFCFC] rounded-lg`}
                    >
                        <EpubReader
                            url={`${import.meta.env.VITE_API_URL}/api/books/${bookFileKey}`}
                        />
                        <ChatInterface isMobile={true} bookId={bookId ?? ""} />
                    </div>
                ) : (
                    <div
                        className={`w-[60%] relative overflow-hidden bg-[#FCFCFC] rounded-lg`}
                    >
                        <EpubReader
                            url={`${import.meta.env.VITE_API_URL}/api/books/${bookFileKey}`}
                        />
                    </div>
                )}
            </div>
        </div>
    );
    return (
        <div className="h-[100dvh] bg-[#D7D7D7] ">
            <div
                className={`h-[100dvh] w-full rounded-lg relative flex justify-center ${!isMobile && "p-8"}`}
            >
                {!isMobile && (
                    <div className="w-[40%] bg-[#FCFCFC] mr-4 rounded-lg">
                        <ChatInterface isMobile={false} />
                    </div>
                )}
                {isMobile ? (
                    <div
                        className={`w-full relative overflow-hidden bg-[#FCFCFC] rounded-lg`}
                    >
                        <EpubReader
                            url={`${import.meta.env.VITE_API_URL}/api/books/${bookId}`}
                        />
                        <ChatInterface isMobile={true} />
                    </div>
                ) : (
                    <div
                        className={`w-[60%] relative overflow-hidden bg-[#FCFCFC] rounded-lg`}
                    >
                        <EpubReader
                            url={`${import.meta.env.VITE_API_URL}/api/books/${bookId}`}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
