import { Button } from "@/components/ui/button";

interface Props {
    onClick: () => void;
    isLoading?: boolean;
}

export function GoogleSignInButton({ onClick, isLoading }: Props) {
    return (
        <Button
            className="w-full bg-white text-gray-900 hover:bg-gray-50 border border-gray-300"
            onClick={onClick}
            disabled={isLoading}
        >
            {isLoading ? "Signing in..." : "Sign in with Google"}
        </Button>
    );
}
