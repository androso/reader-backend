import { useLocation, useParams } from "wouter";
import { useWindowSize } from "../hooks/useWindowSize";
import { ChatInterface } from "../components/reader/ChatInterface";
import EpubReader from "../components/reader/EpubReader";
import { ArrowLeft } from "lucide-react";

export default function Read() {
    const params = useParams();
    const bookFileKey = params.id as string | null;
    const { width } = useWindowSize();
    const isMobile = width < 768; // Using window width for layout decisions
    const [location, setLocation] = useLocation();
    const searchParams = new URLSearchParams(location.split("?")[1]);
    const bookId = searchParams.get("bookId");
    
    const handleGoBack = () => {
        setLocation("/");
    };

    return (
        <div className="h-[100dvh] bg-[#D7D7D7] relative">
            <button 
                onClick={handleGoBack}
                className="absolute top-4 left-4 z-10 flex items-center justify-center p-2 bg-white rounded-full shadow-md hover:bg-gray-100 transition-colors"
                aria-label="Go back to home"
            >
                <ArrowLeft className="h-5 w-5" />
            </button>
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
}
