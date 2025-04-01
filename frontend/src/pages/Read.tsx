import { useParams } from "wouter";
import { useWindowSize } from "../hooks/useWindowSize";
import { ChatInterface } from "../components/reader/ChatInterface";
import EpubReader from "../components/reader-test/EpubReader";

export default function Read() {
    const params = useParams();
    const bookId = params.id as string | null;
    const { width } = useWindowSize();
    const isMobile = width < 768;

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
                            url={`${import.meta.env.VITE_GOOGLE_CLIENT_ID}/api/books/${bookId}`}
                        />
                        <ChatInterface isMobile={true} />
                    </div>
                ) : (
                    <div
                        className={`w-[60%] relative overflow-hidden bg-[#FCFCFC] rounded-lg`}
                    >
                        <EpubReader
                            url={`${import.meta.env.VITE_GOOGLE_CLIENT_ID}/api/books/${bookId}`}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
