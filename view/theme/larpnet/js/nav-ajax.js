// SPDX-FileCopyrightText: 2010-2026 the Friendica project
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPLv3-or-later

/**
 * Intercepts clicks on links inside #tabmenu (the sort/filter tab bar that
 * LarpnetNav.syncTopbarSecond() in theme.js moves into #topbar-second, e.g.
 * the /network "Latest Activity"/"Latest Posts" tabs, reused on /contacts,
 * /circle, /notifications) and swaps only #content instead of doing a full
 * page reload. This is deliberately narrower than full SPA/unpoly navigation
 * (see head.tpl for why that isn't enabled): top-level module links outside
 * #tabmenu are left as normal full page loads.
 *
 * Degrades to a normal navigation on any fetch/parse error, and if this
 * script fails to load or throws before binding, the click handler simply
 * never attaches, so links behave as plain anchors.
 */
(function () {
	function isPlainLeftClick(e) {
		return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
	}

	function findTabmenuLink(target) {
		while (target && target !== document) {
			if (target.matches && target.matches("#tabmenu a[href]")) {
				return target;
			}
			target = target.parentNode;
		}
		return null;
	}

	document.addEventListener("click", function (e) {
		if (e.defaultPrevented || !isPlainLeftClick(e)) {
			return;
		}

		var link = findTabmenuLink(e.target);
		if (!link || link.target === "_blank" || link.hasAttribute("data-toggle") ||
			link.hasAttribute("onclick") || link.classList.contains("add-to-modal")) {
			return;
		}

		var url;
		try {
			url = new URL(link.href, window.location.href);
		} catch (err) {
			return;
		}
		if (url.origin !== window.location.origin) {
			return;
		}

		e.preventDefault();

		// Deliberately not sending X-Requested-With: XMLHttpRequest -- Friendica's
		// Mode::isAjax() would then skip the page_end hook (used by e.g.
		// addon/larpnet_calendar/), so we fetch as a normal navigation and just
		// pick #content out of the full response ourselves.
		fetch(url.href)
			.then(function (response) {
				if (!response.ok) {
					throw new Error("nav-ajax: unexpected status " + response.status);
				}
				return response.text();
			})
			.then(function (html) {
				var doc = new DOMParser().parseFromString(html, "text/html");
				var newContent = doc.getElementById("content");
				var oldContent = document.getElementById("content");
				if (!newContent || !oldContent) {
					throw new Error("nav-ajax: #content not found in response");
				}

				oldContent.replaceWith(newContent);
				if (doc.title) {
					document.title = doc.title;
				}
				window.history.pushState({ larpnetNavAjax: true }, "", url.href);

				LarpnetNav.syncTopbarSecond();
			})
			.catch(function () {
				window.location.href = url.href;
			});
	});

	// We don't keep a fragment history stack, so let the browser reload the
	// target URL on back/forward -- correct content, just not an instant swap.
	window.addEventListener("popstate", function (e) {
		if (e.state && e.state.larpnetNavAjax) {
			window.location.reload();
		}
	});
})();
// @license-end
