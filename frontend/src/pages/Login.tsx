import { Link } from "wouter";

export default function Login() {
    return (
        <div>
            <h1>Login page</h1>
            <Link href="/" className={"text-blue-600 hover:text-blue-800"}>
                Home
            </Link>
        </div>
    );
}
