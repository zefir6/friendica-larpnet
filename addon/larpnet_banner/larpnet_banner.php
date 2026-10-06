<?php
/**
 * Name: Larpnet Banner
 * Description: Baner (header image) profilu dla motywu Larpnet.
 * Version: 1.1
 * Author: larpnet admin <https://larpnet.pl>
 */

use Friendica\Core\Hook;
use Friendica\DI;
use Friendica\Model\Contact;
use Friendica\Model\Photo;

function larpnet_banner_install()
{
	Hook::register('addon_settings',      __FILE__, 'larpnet_banner_settings');
	Hook::register('addon_settings_post', __FILE__, 'larpnet_banner_settings_post');
	Hook::register('profile_tabs',        __FILE__, 'larpnet_banner_tag_owner_tabs');
}

/**
 * Tags the owner-only profile tabs ("Personal notes", "Scheduled posts")
 * with a 'group' key so common_tabs.tpl can set them visually apart from
 * the public tabs (Posts, Photos, ...) on the owner's own view of their
 * profile -- a visitor never gets these tabs at all (BaseProfile::
 * getTabsHTML() already omits them), this is purely about the owner's own
 * tab bar reading as "these are just for you" vs "everyone sees these".
 *
 * Lives in this addon (not a core-file patch to src/Module/BaseProfile.php)
 * purely for deploy cost: BaseProfile.php already dispatches the
 * 'profile_tabs' hook before rendering, and this addon's whole directory
 * already deploys wholesale via Dockerfile -- a new function here needs no
 * new Dockerfile/entrypoint/CLAUDE.md entries, unlike patching a core file
 * Larpnet has never touched before would.
 */
function larpnet_banner_tag_owner_tabs(array &$hook_data)
{
	if (empty($hook_data['tabs']) || !is_array($hook_data['tabs'])) {
		return;
	}

	$ownerOnlyTabIds = ['notes-tab', 'schedule-tab'];

	foreach ($hook_data['tabs'] as &$tab) {
		if (isset($tab['id']) && in_array($tab['id'], $ownerOnlyTabIds, true)) {
			$tab['group'] = 'owner';
		}
	}
	unset($tab);
}

function larpnet_banner_settings(array &$data)
{
	$uid = DI::userSession()->getLocalUserId();
	if (!$uid) {
		return;
	}

	$self = Contact::selectFirst(['id'], ['uid' => $uid, 'self' => true]);
	$cid  = $self['id'] ?? 0;

	$preview = $cid
		? '<p><img src="/photo/header/' . $cid . '" style="max-width:100%;max-height:200px;border-radius:4px;" /></p>'
		: '';

	// The framework wraps our HTML in a plain <form> with no enctype.
	// We patch it to multipart/form-data so the file input is transmitted.
	$html = $preview . '
<div class="form-group">
	<label for="larpnet-banner-file">Wybierz nowy obraz (JPG/PNG, zalecane min. 1500×500 px):</label>
	<input type="file" id="larpnet-banner-file" name="larpnet_banner" accept="image/*" class="form-control"
		onchange="if(this.form){this.form.enctype=\'multipart/form-data\';}" />
</div>
<script>
document.addEventListener("DOMContentLoaded", function() {
	var input = document.getElementById("larpnet-banner-file");
	if (input && input.form) { input.form.enctype = "multipart/form-data"; }
});
</script>';

	$data = [
		'addon'  => 'larpnet_banner',
		'title'  => 'Baner profilu',
		'html'   => $html,
		'submit' => 'Prześlij baner',
	];
}

function larpnet_banner_settings_post(array &$b)
{
	if (!DI::userSession()->getLocalUserId()) {
		return;
	}
	// Framework submit button name is "{addon}-submit" = "larpnet_banner-submit"
	if (empty($_POST['larpnet_banner-submit'])) {
		return;
	}
	if (empty($_FILES['larpnet_banner']['tmp_name'])) {
		return;
	}

	$uid    = DI::userSession()->getLocalUserId();
	$result = Photo::uploadBanner($uid, $_FILES['larpnet_banner']);

	if ($result) {
		DI::sysmsg()->addInfo(DI::l10n()->t('Baner profilu zaktualizowany.'));
	} else {
		DI::sysmsg()->addNotice(DI::l10n()->t('Nie udało się przesłać banera. Sprawdź format i rozmiar pliku.'));
	}
}
