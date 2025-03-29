import { Route, Switch } from "wouter";
import Home from "./pages/Home";
import Login from "./pages/Login";

export default function App() {
    return (
        <div className="App w-screen h-screen">
            <Switch>
                <Route path="/" component={Home} />
                <Route path="/login" component={Login} />
            </Switch>
        </div>
    );
}
