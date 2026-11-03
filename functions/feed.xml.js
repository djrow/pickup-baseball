import { renderFeedXmlResponse } from '../src/app/feeds.js';

export async function onRequest(context) {
  return renderFeedXmlResponse(context.env && context.env.DB, context.request.url);
}
