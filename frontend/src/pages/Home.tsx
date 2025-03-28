import { Link } from "wouter";

export default function Home() {
    return (
        <div className="p-6">
            <h1 className="text-3xl font-bold mb-4">Welcome to mentarie</h1>
            <p className="text-lg">Your digital reading companion</p>
            <Link href="/login">
                <a className="text-blue-600 hover:text-blue-800">Login</a>
            </Link>
        </div>
    );
}
