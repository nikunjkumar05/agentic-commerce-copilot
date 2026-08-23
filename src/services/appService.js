import { api } from './api.js';

export const appService = {
  async getPublicSettings(appId) {
    return api.get(`/apps/public/prod/public-settings/by-id/${appId}`);
  },
};
