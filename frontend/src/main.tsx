import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { GoogleOAuthProvider } from "@react-oauth/google";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "react-hot-toast";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <GoogleOAuthProvider clientId={import.meta.env.GOOGLE_CLIENT_ID}>
            <QueryClientProvider client={queryClient}>
                <App />
            </QueryClientProvider>
            <Toaster />
        </GoogleOAuthProvider>
    </React.StrictMode>
);
