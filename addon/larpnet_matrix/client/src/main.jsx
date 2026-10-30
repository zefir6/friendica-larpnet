import { render } from 'preact';
import { App } from './App.jsx';
import { setChatLocale } from './matrix.js';

const config = window.LARPNET_CHAT_CONFIG || {};
setChatLocale(config.locale);
render(<App config={config} />, document.getElementById('app'));
