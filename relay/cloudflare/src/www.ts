/** www.noemaboard.app: a permanent redirect to the same page on https://noemaboard.app. */
export default {
  fetch(request: Request): Response {
    const url = new URL(request.url)
    return Response.redirect(`https://noemaboard.app${url.pathname}${url.search}`, 301)
  },
}
