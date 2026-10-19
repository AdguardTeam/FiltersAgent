Session {{sessionOrdinal}} ran {{sessionDescription}}, but a later launch_browser or close_browser closed it before its full-page capture was complete; nothing can capture it any more.
Relaunch that environment: call launch_browser with the same extension, targetUrl and settings, then open_page.
Capture and inspect its full page: every original-resolution tile, and the overview when the browser captured one that vision can read. Then call finish_fix again.
