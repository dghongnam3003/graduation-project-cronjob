// env config
/* eslint-disable */
import * as process from 'process';
import { z } from 'zod';

// Campaign API endpoints
export const MONGO_URI = process.env.MONGO_URI
export const RPC = process.env.RPC;
export const OPERATOR_PRIV_KEY = process.env.OPERATOR_PRIV_KEY;
export const PORT = process.env.PORT;
export const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
// Logging configuration
export const LOG_LEVEL_SCHEMA = z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info');

export const LOG_LEVEL = LOG_LEVEL_SCHEMA.parse(
    process.env.LOG_LEVEL ?? 'info'
);

// Environment flags
export const isDev = process.env.NODE_ENV === 'dev';
export const isProd = process.env.NODE_ENV === 'production';

// Config getter function
export const getConfigs = () => {
    return {
        api: {
            mongo_uri: MONGO_URI,
            rpc: RPC,
            operator_priv_key: OPERATOR_PRIV_KEY,
            port: Number(PORT),
        },
        environment: {
            isDev,
            isProd
        }
    };
};

// Export default config
export const configs = getConfigs();