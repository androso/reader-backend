import { AuthProtection } from "../components/AuthProtection";

export default function Home() {
    return (
        <AuthProtection>
            <h1>Protected route</h1>
        </AuthProtection>
    );
}
