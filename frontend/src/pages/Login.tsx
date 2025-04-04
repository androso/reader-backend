import { Card } from "../components/ui/card";
import { useGoogleSignIn, useUser } from "../lib/auth";
import { useGoogleLogin } from "@react-oauth/google";
import { GoogleSignInButton } from "../components/GoogleSignInButton";
import { LoadingSpinner } from "../components/ui/LoadingSpinner";
import { useEffect } from "react";
import { useLocation } from "wouter";
import { BookOpen } from "lucide-react";

export default function Login() {
    const [_, setLocation] = useLocation();
    const { data: userData, status: userStatus } = useUser();
    const {
        mutateAsync: signIn,
        isPending: googlePending,
        status: googleStatus,
    } = useGoogleSignIn();

    const login = useGoogleLogin({
        onSuccess: async (codeResponse: { access_token: string }) => {
            await signIn(codeResponse.access_token);
            setLocation("/");
        },
        onError: (error: unknown) => {
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
        <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-br from-[#EEF0FF] via-white to-[#F5F0FF]">
            <div className="w-full max-w-md p-8">
                <Card className="w-full overflow-hidden shadow-xl border border-[#4e56e6]/10 bg-white/95 backdrop-blur-sm">
                    <div className="p-8">
                        <div className="flex justify-center mb-8">
                            <div className="rounded-full bg-[#4e56e6]/10 p-4 shadow-inner shadow-[#4e56e6]/5">
                                <BookOpen className="h-9 w-9 text-[#4e56e6]" />
                            </div>
                        </div>
                        
                        <h1 className="text-3xl font-bold text-center mb-3 text-gray-800">
                            Welcome Back
                        </h1>
                        <p className="text-center text-gray-500 mb-8">
                            Sign in to continue to your account
                        </p>
                        
                        <GoogleSignInButton
                            onClick={() => {
                                login();
                            }}
                            isLoading={googlePending}
                        />
                        
                        <div className="mt-6 text-center">
                            <p className="text-sm text-gray-500">
                                By signing in, you agree to our 
                                <span className="text-[#4e56e6] hover:underline cursor-pointer ml-1">
                                    Terms of Service
                                </span>
                            </p>
                        </div>
                    </div>
                </Card>
            </div>
        </div>
    );
}
