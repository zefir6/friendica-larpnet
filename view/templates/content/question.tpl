{{*
  * Copyright (C) 2010-2026, the Friendica project
  * SPDX-FileCopyrightText: 2010-2026 the Friendica project
  *
  * SPDX-License-Identifier: AGPL-3.0-or-later
  *}}
</p>
{{if $question.can_vote}}
<form class="poll-vote-form" action="item/{{$question.item_id}}/vote" method="post">
	<ul class="poll-options">
	{{foreach $options as $option}}
		<li>
			<label>
				<input type="{{if $question.multiple}}checkbox{{else}}radio{{/if}}" name="options[]" value="{{$option.id}}">
				{{$option.name}}
			</label>
		</li>
	{{/foreach}}
	</ul>
	<input type="hidden" name="return" value="{{$return_path}}">
	<button type="submit" class="btn btn-primary btn-sm poll-vote-submit">{{$vote_label}}</button>
</form>
{{else}}
<ul>
{{foreach $options as $option}}
	<li>{{$option.vote}}</li>
{{/foreach}}
</ul>
{{/if}}
{{$summary}}
</p>
