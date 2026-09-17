import { NestFactory, HttpAdapterHost } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { attachApiLifecycle, defaultApiResources } from "./api-lifecycle";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { handleBodyParserError } from "./common/middleware/body-errors";
import { enforceTrustedOrigin } from "./common/middleware/csrf";
import { logger } from "./common/middleware/request-logger";

const allowedOrigins = [
    process.env.FRONTEND_URL,
    ...(process.env.NODE_ENV === "production"
        ? []
        : [
              "http://localhost:5173",
              "http://127.0.0.1:5173",
              "http://localhost:3001",
              "http://127.0.0.1:3001",
          ]),
].filter(Boolean);

if (allowedOrigins.length === 0) {
    console.warn("No CORS origins configured");
}

export const corsOptions = {
    origin: (
        origin: string | undefined,
        callback: (err: Error | null, allow?: boolean) => void
    ) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
            return;
        }

        callback(new Error(`CORS origin not allowed: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
};

export function configureApp(app: NestExpressApplication): void {
    app.enableCors(corsOptions);
    app.useBodyParser("json");
    app.useBodyParser("urlencoded", { extended: false });
    app.use(handleBodyParserError);
    app.use(logger);
    app.use(enforceTrustedOrigin);
    app.useGlobalFilters(
        new AllExceptionsFilter(app.get(HttpAdapterHost).httpAdapter)
    );
    const config = new DocumentBuilder()
        .setTitle("Mentarie API")
        .setVersion("1.0.0")
        .setDescription(
            "Mentarie API Documentation to provide all the endpoints, and how to use it to interact with the application"
        )
        .addServer("http://localhost:3000")
        .addBearerAuth()
        .build();
    SwaggerModule.setup(
        "api-docs",
        app,
        SwaggerModule.createDocument(app, config)
    );
}

export async function createApp(): Promise<NestExpressApplication> {
    let app: NestExpressApplication | undefined;
    try {
        app = await NestFactory.create<NestExpressApplication>(AppModule, {
            bodyParser: false,
            abortOnError: false,
        });
        attachApiLifecycle(app, defaultApiResources);
        configureApp(app);
        return app;
    } catch (error) {
        const errors: unknown[] = [error];
        try {
            if (app) {
                await app.close();
            } else {
                await defaultApiResources.close();
            }
        } catch (cleanupError) {
            errors.push(cleanupError);
        }
        throw new AggregateError(errors, "API startup failed");
    }
}
