import { Test } from "@nestjs/testing";
import { HttpAdapterHost } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { ModuleMetadata, Provider, Type } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../src/common/guards/auth.guard";
import { AllExceptionsFilter } from "../../src/common/filters/all-exceptions.filter";
import { DRIZZLE } from "../../src/database/database.module";
import type { User } from "../../src/types";

export type TestAppOptions = {
    controllers?: Type<unknown>[];
    providers?: Provider[];
    imports?: ModuleMetadata["imports"];
    user?: User;
    db?: unknown;
};

export const createTestApp = async (options: TestAppOptions) => {
    let builder = Test.createTestingModule({
        imports: options.imports ?? [],
        controllers: options.controllers ?? [],
        providers: options.providers ?? [],
    });

    if (options.user !== undefined) {
        builder = builder.overrideGuard(AuthGuard).useValue({
            canActivate: (context: {
                switchToHttp: () => { getRequest: <T>() => T };
            }) => {
                context.switchToHttp().getRequest<Request>().user =
                    options.user!;
                return true;
            },
        });
    }
    if (options.db !== undefined) {
        builder = builder.overrideProvider(DRIZZLE).useValue(options.db);
    }

    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    app.useGlobalFilters(
        new AllExceptionsFilter(app.get(HttpAdapterHost).httpAdapter)
    );
    await app.listen(0);

    const address = app.getHttpServer().address();
    const port = typeof address === "object" && address ? address.port : 0;

    return {
        app,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => app.close(),
    };
};
