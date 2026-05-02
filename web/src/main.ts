import './styles.css';
import { mount } from 'svelte';
import App from './App.svelte';

const target = document.querySelector('#app');
if (!target) throw new Error('#app element missing in index.html');

const app = mount(App, { target });

export default app;
