import type { HTTPRequest, HTTPResponse, RefreshableScheme, RefreshableSchemeOptions, SchemeCheck, SchemePartialOptions } from '../../types';
import type { Auth } from '..';
import { cleanObj, getProp } from '../../utils';
import { RefreshController, RefreshToken, ExpiredAuthSessionError } from '../inc';
import { LocalScheme, LocalSchemeEndpoints, LocalSchemeOptions } from './local';

export interface RefreshSchemeEndpoints extends LocalSchemeEndpoints {
    refresh: HTTPRequest;
}

export interface RefreshSchemeOptions extends LocalSchemeOptions, RefreshableSchemeOptions {
    endpoints: RefreshSchemeEndpoints;
    autoLogout: boolean;
}

const DEFAULTS: SchemePartialOptions<RefreshSchemeOptions> = {
    name: 'refresh',
    endpoints: {
        refresh: {
            url: '/api/auth/refresh',
            method: 'post',
        },
    },
    refreshToken: {
        property: 'refresh_token',
        data: 'refresh_token',
        maxAge: 60 * 60 * 24 * 30,
        required: true,
        tokenRequired: false,
        prefix: '_refresh_token.',
        expirationPrefix: '_refresh_token_expiration.',
    },
    autoLogout: false,
};

export class RefreshScheme<OptionsT extends RefreshSchemeOptions = RefreshSchemeOptions> extends LocalScheme<OptionsT> implements RefreshableScheme<OptionsT>
{
    refreshToken: RefreshToken;
    refreshController: RefreshController;
    refreshRequest: Promise<HTTPResponse> | null = null

    constructor($auth: Auth, options: SchemePartialOptions<RefreshSchemeOptions>) {
        super($auth, options, DEFAULTS);

        // Initialize Refresh Token instance
        this.refreshToken = new RefreshToken(this, this.$auth.$storage);

        // Initialize Refresh Controller
        this.refreshController = new RefreshController(this);
    }

    check(checkStatus = false): SchemeCheck {
        const response = {
            valid: false,
            tokenExpired: false,
            refreshTokenExpired: false,
            isRefreshable: true,
        };

        // Sync tokens
        const token = this.token.sync();
        const refreshToken = this.refreshToken.sync();

        // Token and refresh token are required but not available
        if (!token || !refreshToken) {
            return response;
        }

        // Check status wasn't enabled, let it pass
        if (!checkStatus) {
            response.valid = true;
            return response;
        }

        // Get status
        const tokenStatus = this.token.status();
        const refreshTokenStatus = this.refreshToken.status();

        // Refresh token has expired. There is no way to refresh. Force reset.
        if (refreshTokenStatus.expired()) {
            response.refreshTokenExpired = true;
            return response;
        }

        // Token has expired, Force reset.
        if (tokenStatus.expired()) {
            response.tokenExpired = true;
            return response;
        }

        response.valid = true;
        return response;
    }

    mounted(): Promise<HTTPResponse | void> {
        return super.mounted({
            tokenCallback: () => {
                if (this.options.autoLogout) {
                    this.$auth.reset();
                }
            },
            // @ts-ignore
            refreshTokenCallback: () => {
                this.$auth.reset();
            },
        });
    }

    async refreshTokens(): Promise<HTTPResponse | void> {
        // Refresh endpoint is disabled
        if (!this.options.endpoints.refresh) {
            return Promise.resolve();
        }

        // Token and refresh token are required but not available
        if (!this.check().valid) {
            return Promise.resolve();
        }

        // Get refresh token status
        const refreshTokenStatus = this.refreshToken.status();

        // Refresh token is expired. There is no way to refresh. Force reset.
        if (refreshTokenStatus.expired()) {
            this.$auth.reset();

            throw new ExpiredAuthSessionError();
        }

        // Delete current token from the request header before refreshing, if `tokenRequired` is disabled
        if (!this.options.refreshToken.tokenRequired) {
            this.requestHandler.clearHeader();
        }

        const endpoint: {
            body: {
                [key: string]: string | boolean | undefined
                client_id: string | undefined,
                grant_type: string | undefined,
            },
        } = {
            body: {
                client_id: undefined,
                grant_type: undefined,
            },
        };

        // Add refresh token to payload if required
        if (this.options.refreshToken.required && this.options.refreshToken.data) {
            endpoint.body[this.options.refreshToken.data] = this.refreshToken.get();
        }

        // Add client id to payload if defined
        if (this.options.clientId) {
            endpoint.body.client_id = this.options.clientId;
        }

        // Add grant type to payload if defined
        if (this.options.grantType) {
            endpoint.body.grant_type = 'refresh_token';
        }

        cleanObj(endpoint.body);

        this.refreshRequest = this.refreshRequest || this.$auth.request(endpoint, this.options.endpoints.refresh) as Promise<HTTPResponse>
  
        return this.refreshRequest
            .then((response) => {
                // Update tokens
                this.updateTokens(response, { isRefreshing: true })
                return response
            })
            .catch((error) => {
                this.$auth.callOnError(error, { method: 'refreshToken' })
                return Promise.reject(error)
            })
            .finally(() => {
                // Reset the refresh request
                this.refreshRequest = null
            })
    }

    setUserToken(token: string | boolean, refreshToken?: string | boolean): Promise<HTTPResponse | void> {
        this.token.set(token);

        if (refreshToken) {
            this.refreshToken.set(refreshToken);
        }

        // Fetch user
        return this.fetchUser();
    }

    reset({ resetInterceptor = true } = {}): void {
        this.$auth.setUser(false);
        this.token.reset();
        this.refreshToken.reset();

        if (resetInterceptor) {
            this.requestHandler.reset();
        }
    }

    protected updateTokens(response: HTTPResponse, { isRefreshing = false, updateOnRefresh = true } = {}): void {
        const token = this.options.token?.required ? (getProp(response, this.options.token.property) as string) : true;
        const refreshToken = this.options.refreshToken.required ? (getProp(response, this.options.refreshToken.property) as string) : true;

        this.token.set(token);

        // Update refresh token if defined and if `isRefreshing` is `false`
        // If `isRefreshing` is `true`, then only update if `updateOnRefresh` is also `true`
        if (refreshToken && (!isRefreshing || (isRefreshing && updateOnRefresh))) {
            this.refreshToken.set(refreshToken);
        }
    }

    protected initializeRequestInterceptor(): void {
        this.requestHandler.initializeRequestInterceptor(
            this.options.endpoints.refresh.url
        );
    }
}
