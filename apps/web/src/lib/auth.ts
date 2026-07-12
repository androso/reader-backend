import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "./queryClient";

export interface User {
    id: string;
    name: string;
    email?: string;
    provider?: string;
}

export function useUser() {
    return useQuery({
        queryKey: [`${process.env.NEXT_PUBLIC_API_URL}/api/user`],
        queryFn: async () => {
            const response = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/user`,
                {
                    credentials: "include",
                }
            );
            if (!response.ok) {
                throw new Error("Network response was not ok");
            }
            return response.json();
        },
        enabled: true,
        retry: false,
    });
}

export function useGoogleSignIn() {
    return useMutation({
        mutationFn: async (idToken: string) => {
            try {
                const res = await fetch(
                    `${process.env.NEXT_PUBLIC_API_URL}/api/auth/google`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                        },
                        credentials: "include",
                        body: JSON.stringify({ idToken }),
                    }
                );

                if (!res.ok) {
                    throw new Error("Authentication failed");
                }

                const data = await res.json();
                return data;
            } catch (error) {
                console.error("Error in Google sign-in mutation:", error);
                throw error;
            }
        },
        onSuccess: () => {
            try {
                queryClient.invalidateQueries({
                    queryKey: [`${process.env.NEXT_PUBLIC_API_URL}/api/user`],
                });
            } catch (error) {
                console.error("Error in onSuccess callback:", error);
            }
        },
    });
}

export function useDevSignIn() {
    return useMutation({
        mutationFn: async () => {
            try {
                const res = await fetch(
                    `${process.env.NEXT_PUBLIC_API_URL}/api/auth/dev`,
                    {
                        method: "POST",
                        credentials: "include",
                    }
                );

                if (!res.ok) {
                    const errorText = await res.text();
                    throw new Error(
                        `Dev authentication failed: ${res.status} ${res.statusText}${errorText ? ` - ${errorText}` : ""}`
                    );
                }

                const data = await res.json();
                return data;
            } catch (error) {
                console.error("Error in dev sign-in mutation:", error);
                throw error;
            }
        },
        onSuccess: () => {
            try {
                queryClient.invalidateQueries({
                    queryKey: [`${process.env.NEXT_PUBLIC_API_URL}/api/user`],
                });
            } catch (error) {
                console.error(
                    "Error in dev sign-in onSuccess callback:",
                    error
                );
            }
        },
    });
}

export async function signOut() {
    try {
        await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/logout`, {
            method: "POST",
            credentials: "include",
        });
    } finally {
        queryClient.clear();
    }
}
