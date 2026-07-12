"use client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { useDevSignIn, useGoogleSignIn, useUser } from "@/lib/auth";
import { GoogleLogin } from "@react-oauth/google";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { useEffect } from "react";

export default function Login() {
    const router = useRouter();
    const isDevelopment = process.env.NODE_ENV === "development";
    const { data: userData, status: userStatus } = useUser();
    const {
        mutateAsync: signIn,
        isPending: googlePending,
        status: googleStatus,
    } = useGoogleSignIn();
    const {
        mutateAsync: signInDev,
        isPending: devPending,
        status: devStatus,
    } = useDevSignIn();

    const loginDevUser = async () => {
        await signInDev();
        router.push("/");
    };

    useEffect(() => {
        if (userStatus == "success" && userData) {
            router.push("/");
        }
    }, [userStatus, userData]);

    // Show loading state while redirecting
    if (
        userStatus == "pending" &&
        (googlePending ||
            googleStatus == "success" ||
            devPending ||
            devStatus == "success")
    ) {
        return <LoadingSpinner />;
    }

    return (
        <div className="container mx-auto flex items-center justify-center min-h-screen">
            <Card className="w-full max-w-md p-6">
                <h1 className="text-2xl font-semibold text-center mb-6">
                    Login
                </h1>
                {isDevelopment ? (
                    <Button
                        className="w-full"
                        onClick={loginDevUser}
                        disabled={devPending}
                    >
                        {devPending ? "Signing in..." : "Continue as Dev User"}
                    </Button>
                ) : (
                    <div className="flex justify-center">
                        <GoogleLogin
                            onSuccess={async ({ credential }) => {
                                if (!credential) return;
                                await signIn(credential);
                                router.push("/");
                            }}
                            onError={() => console.error("Login Failed")}
                        />
                    </div>
                )}
            </Card>
        </div>
    );
}
