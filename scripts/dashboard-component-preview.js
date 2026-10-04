import '../src/styles.css';
import '../src/hanni/css/calendar-dashboard-v7.css';
import {mountDashboardComponentFixture} from './dashboard-component-fixture.js';
const dispose=mountDashboardComponentFixture(document.querySelector('[data-fixture-host]'),{markup:document.querySelector('[data-fixture-markup]').innerHTML,scenario:document.body.dataset.scenario,theme:document.body.dataset.theme,view:document.body.dataset.view});
window.addEventListener('pagehide',dispose);
