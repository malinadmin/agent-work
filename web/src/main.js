import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import { applyTheme, readTheme } from './theme.js';
applyTheme(readTheme());
createApp(App).mount('#app');
