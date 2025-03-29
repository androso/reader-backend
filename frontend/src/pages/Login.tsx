import { Card } from "../components/ui/card";
import { useGoogleSignIn, useUser } from "../lib/auth";
import { useGoogleLogin } from "@react-oauth/google";
import { GoogleSignInButton } from "../components/GoogleSignInButton";
import { LoadingSpinner } from "../components/ui/LoadingSpinner";
import { useEffect } from "react";
import { useLocation } from "wouter";

export default function Login() {
    const [_, setLocation] = useLocation();
    const { data: userData, status: userStatus } = useUser();
    const {
        mutateAsync: signIn,
        isPending: googlePending,
        status: googleStatus,
    } = useGoogleSignIn();

    const login = useGoogleLogin({
        onSuccess: async (codeResponse) => {
            await signIn(codeResponse.access_token);
            setLocation("/");
        },
        onError: (error) => {
            console.error("Login Failed:", error);
        },
    });

    useEffect(() => {
        if (userStatus == "success" && userData) {
            setLocation("/");
        }
    }, [userStatus, userData]);

    // Show loading state while redirecting
    if (
        userStatus == "pending" &&
        (googlePending || googleStatus == "success")
    ) {
        return <LoadingSpinner />;
    }

    return (
        <div className="container mx-auto flex items-center justify-center min-h-screen w-screen">
            <Card className="w-full max-w-md p-6">
                <h1 className="text-2xl font-semibold text-center mb-6">
                    Login
                </h1>
                <GoogleSignInButton
                    onClick={() => {
                        login();
                    }}
                    isLoading={googlePending}
                />
            </Card>
        </div>
    );
}
