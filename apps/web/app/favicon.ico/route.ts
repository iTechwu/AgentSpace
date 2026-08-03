function redirectToAppIcon(): Response {
  return new Response(null, {
    headers: { location: "/icon.svg" },
    status: 307,
  });
}

export const GET = redirectToAppIcon;
export const HEAD = redirectToAppIcon;
