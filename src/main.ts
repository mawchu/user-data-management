import { createApp } from 'vue'
import App from './App.vue'
import { setupMock } from './mock/setup'
import './style.css'

const app = createApp(App)
// 接真後端時刪掉這一行：API 層就會改用瀏覽器原生 fetch
app.provide('apiReady', setupMock())
app.mount('#app')
