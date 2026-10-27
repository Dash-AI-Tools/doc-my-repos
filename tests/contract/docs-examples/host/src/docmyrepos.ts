import { createApp } from "@docmyrepos/server";

export const app = createApp({
  hooks: {
    onEvent: (event) => {
      console.log(event.name, event.tenantId);
    },
  },
});
