import { useUser } from "@/lib/auth";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LoadingSpinner } from "./ui/LoadingSpinner";

export function AuthProtection({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const { status: userStatus, data: userData } = useUser();

    useEffect(() => {
        if ((userStatus == "success" && !userData) || userStatus == "error") {
            router.push("/login");
        }
    }, [userStatus, userData, router]);

    if (userStatus == "pending") {
        return <LoadingSpinner />;
    }

    if (!userData) return null;

    return <>{children}</>;
}
