import { render } from 'preact';
import { App } from './App.jsx';

const config = window.LARPNET_CHAT_CONFIG || {};
render(<App config={config} />, document.getElementById('app'));
