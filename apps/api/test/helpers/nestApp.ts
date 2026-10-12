import { Test } from "@nestjs/testing";
import { HttpAdapterHost } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { ModuleMetadata, Provider, Type } from "@nestjs/common";
import type { Request } from "express";
import { AllExceptionsFilter } from "../../src/common/filters/all-exceptions.filter";
import { AUTHENTICATE_SESSION } from "../../src/auth/auth.tokens";
import { DRIZZLE } from "../../src/database/database.module";
import type { User } from "../../src/types";

export type TestAppOptions = {
    controllers?: Type<unknown>[];
    providers?: Provider[];
    imports?: ModuleMetadata["imports"];
    user?: User;
    db?: unknown;
    fullStack?: boolean;
    overrides?: Array<{
        token: string | symbol | Type<unknown>;
        useValue: unknown;
    }>;
};

export const createTestApp = async (options: TestAppOptions) => {
    const imports = options.fullStack
        ? (options.imports ?? [
              (
                  require("../../src/app.module") as typeof import("../../src/app.module")
              ).AppModule,
          ])
        : (options.imports ?? []);

    let builder = Test.createTestingModule({
        imports,
        controllers: options.controllers ?? [],
        providers: [
            ...(!options.fullStack
                ? [
                      {
                          provide: AUTHENTICATE_SESSION,
                          useValue: {
                              execute: async (token: string) => {
                                  const { verifyToken } =
                                      require("../../src/services/AuthService") as typeof import("../../src/services/AuthService");
                                  const dbProvider = options.providers?.find(
                                      (provider) =>
                                          typeof provider === "object" &&
                                          provider !== null &&
                                          "provide" in provider &&
                                          provider.provide === DRIZZLE &&
                                          "useValue" in provider
                                  );
                                  const configuredDb =
                                      options.db ??
                                      (
                                          dbProvider as
                                              | { useValue?: unknown }
                                              | undefined
                                      )?.useValue;
                                  return verifyToken(
                                      token,
                                      configuredDb as never
                                  );
                              },
                          },
                      },
                  ]
                : []),
            ...(options.providers ?? []),
        ],
    });

    if (options.user !== undefined) {
        const { AuthGuard } =
            require("../../src/common/guards/auth.guard") as typeof import("../../src/common/guards/auth.guard");
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
    for (const override of options.overrides ?? []) {
        builder = builder
            .overrideProvider(override.token)
            .useValue(override.useValue);
    }

    const moduleRef = await builder.compile();
    const app = options.fullStack
        ? moduleRef.createNestApplication<NestExpressApplication>({
              bodyParser: false,
          })
        : moduleRef.createNestApplication<NestExpressApplication>();

    if (options.fullStack) {
        const { configureApp } =
            require("../../src/bootstrap") as typeof import("../../src/bootstrap");
        configureApp(app);
    } else {
        app.useGlobalFilters(
            new AllExceptionsFilter(app.get(HttpAdapterHost).httpAdapter)
        );
    }
    await app.listen(0);

    const address = app.getHttpServer().address();
    const port = typeof address === "object" && address ? address.port : 0;

    return {
        app,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => app.close(),
    };
};
