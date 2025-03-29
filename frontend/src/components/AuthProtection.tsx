import { useUser } from "../lib/auth";
import { useEffect } from "react";
import { LoadingSpinner } from "./ui/LoadingSpinner";
import { useLocation } from "wouter";

export function AuthProtection({ children }: { children: React.ReactNode }) {
    const [_, setLocation] = useLocation();
    const { status: userStatus, data: userData } = useUser();

    useEffect(() => {
        if ((userStatus == "success" && !userData) || userStatus == "error") {
            setLocation("/login");
        }
    }, [userStatus, userData]);

    if (userStatus == "pending") {
        return <LoadingSpinner />;
    }

    if (!userData) return null;

    return <>{children}</>;
}
