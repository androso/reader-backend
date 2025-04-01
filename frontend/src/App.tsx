import { Route, Switch } from "wouter";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Read from "./pages/Read";

export default function App() {
    return (
        <div className="App w-screen h-screen">
            <Switch>
                <Route path="/" component={Home} />
                <Route path="/login" component={Login} />
                <Route path="/read/:id" component={Read} />
            </Switch>
        </div>
    );
}
