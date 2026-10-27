/**
 * 心印 · 设置页（Client 半边）。
 *
 * 注册在 Plugins 设置区的「心印」页里，只做配置：名字 / 人格 / 性格 /
 * 交付节奏 / 交付目录。数据通过 Host 注册的同源 JSON 接口读写：
 *   GET  /dsh-heartprint/api/state
 *   POST /dsh-heartprint/api/policy   { patch: {...} }
 *
 * 不读宿主 DOM、不引宿主组件库；样式只用主题 token（--dsw-alias-*）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-heartprint',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const S = {
      wrap: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        maxWidth: '720px',
        padding: '4px 0 24px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: '1.6',
      },
      card: {
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '12px',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      },
      title: { fontSize: '14px', fontWeight: 600, margin: 0 },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', margin: 0 },
      row: { display: 'flex', flexDirection: 'column', gap: '6px' },
      label: { fontWeight: 500 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        padding: '7px 10px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        fontFamily: 'inherit',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        padding: '7px 10px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        fontFamily: 'inherit',
        minHeight: '64px',
        resize: 'vertical',
      },
      grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
      actions: { display: 'flex', alignItems: 'center', gap: '12px' },
      button: {
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        border: 'none',
        borderRadius: '8px',
        padding: '7px 16px',
        fontSize: '13px',
        cursor: 'pointer',
      },
      buttonDisabled: { opacity: 0.55, cursor: 'default' },
      ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: '12px' },
      bad: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', fontSize: '12px' },
      kvKey: { color: 'var(--dsw-alias-label-secondary)' },
    }

    function readError(payload) {
      if (!payload) return '请求失败'
      if (payload.error && typeof payload.error.message === 'string') return payload.error.message
      if (typeof payload.summary === 'string') return payload.summary
      return '请求失败'
    }

    function Field(props) {
      return h('label', { style: S.row },
        h('span', { style: S.label }, props.label),
        props.children,
        props.hint ? h('span', { style: S.hint }, props.hint) : null,
      )
    }

    function HeartprintSettings() {
      const [loaded, setLoaded] = useState(null)
      const [form, setForm] = useState(null)
      const [message, setMessage] = useState(null)
      const [busy, setBusy] = useState(false)

      const applyState = useCallback((payload) => {
        if (!payload || payload.ok === false) return
        const policy = payload.policy || {}
        setLoaded(payload)
        setForm({
          personaName: policy.personaName || '',
          personaProfile: policy.personaProfile || '',
          characterProfile: policy.characterProfile || '',
          firstDeliveryAfterDays: policy.firstDeliveryAfterDays ?? 90,
          deliveryIntervalDays: policy.deliveryIntervalDays ?? 30,
          deliveryDir: policy.deliveryDir || '',
        })
      }, [])

      useEffect(() => {
        let alive = true
        fetch('/dsh-heartprint/api/state', { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((payload) => { if (alive) applyState(payload) })
          .catch(() => { if (alive) setMessage({ kind: 'bad', text: '读取配置失败：接口没响应' }) })
        return () => { alive = false }
      }, [applyState])

      const update = (key) => (event) => {
        const value = event && event.target ? event.target.value : event
        setForm((current) => (current ? { ...current, [key]: value } : current))
      }

      const save = () => {
        if (!form || busy) return
        setBusy(true)
        setMessage(null)
        fetch('/dsh-heartprint/api/policy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            patch: {
              personaName: form.personaName,
              personaProfile: form.personaProfile,
              characterProfile: form.characterProfile,
              firstDeliveryAfterDays: Number(form.firstDeliveryAfterDays) || 90,
              deliveryIntervalDays: Number(form.deliveryIntervalDays) || 30,
              deliveryDir: form.deliveryDir,
            },
          }),
        })
          .then((res) => res.json())
          .then((payload) => {
            if (payload && payload.ok === false) {
              setMessage({ kind: 'bad', text: readError(payload) })
              return
            }
            applyState(payload)
            setMessage({ kind: 'ok', text: '已保存' })
          })
          .catch(() => setMessage({ kind: 'bad', text: '保存失败：接口没响应' }))
          .finally(() => setBusy(false))
      }

      if (!form) {
        return h('div', { style: S.wrap }, h('p', { style: S.hint }, '正在读取心印配置…'))
      }

      const delivery = (loaded && loaded.delivery) || {}
      const policy = (loaded && loaded.policy) || {}

      return h('div', { style: S.wrap },
        h('div', { style: S.card },
          h('h3', { style: S.title }, '心印 · 设定'),
          h('p', { style: S.hint }, '这些是「你自己设置」的部分：AI 被问起性格、人格或价值观时，只会回答这里填的内容。'),
          h(Field, { label: '名字', hint: '交付的文件名会用到它；留空时暂用「心印」。' },
            h('input', { style: S.input, value: form.personaName, onChange: update('personaName'), placeholder: '给这个 AI 起的名字' })),
          h(Field, { label: '人格设定', hint: '希望它是什么样的身份、语气、称呼方式；最多 400 字。' },
            h('textarea', { style: S.textarea, value: form.personaProfile, onChange: update('personaProfile') })),
          h(Field, { label: '性格设定', hint: '性格特质、说话风格、喜欢与不喜欢；最多 400 字。' },
            h('textarea', { style: S.textarea, value: form.characterProfile, onChange: update('characterProfile') })),
        ),
        h('div', { style: S.card },
          h('h3', { style: S.title }, '交付节奏'),
          h('div', { style: S.grid },
            h(Field, { label: '首次交付（天）' },
              h('input', { style: S.input, type: 'number', min: 1, value: form.firstDeliveryAfterDays, onChange: update('firstDeliveryAfterDays') })),
            h(Field, { label: '之后每隔（天）' },
              h('input', { style: S.input, type: 'number', min: 1, value: form.deliveryIntervalDays, onChange: update('deliveryIntervalDays') })),
          ),
          h(Field, { label: '交付目录', hint: '留空时写到当前工作区下的「心印交付」；支持绝对路径。' },
            h('input', { style: S.input, value: form.deliveryDir, onChange: update('deliveryDir'), placeholder: '例如 D:\\心印交付' })),
          h('div', { style: S.kv },
            h('span', { style: S.kvKey }, '下次交付'),
            h('span', null, delivery.nextText || '尚未安排'),
            h('span', { style: S.kvKey }, '文档状态'),
            h('span', null, policy.disclosure === 'disclosed' ? '已交付' : '保密中（尚未交付）'),
            h('span', { style: S.kvKey }, '记忆条目'),
            h('span', null, String((loaded && loaded.records) || 0)),
          ),
        ),
        h('div', { style: S.card },
          h('h3', { style: S.title }, '遗忘日历（查看）'),
          h('p', { style: S.hint }, `重要阈值 ${policy.importantThreshold ?? 70} · 次重要阈值 ${policy.secondaryThreshold ?? 40} · 加密档案同步 ${policy.syncIntervalDays ?? 30} 天`),
          h('p', { style: S.hint }, '要精确调整每层日期，用对话让 AI 调 heartprint_admin action=policy。'),
        ),
        h('div', { style: S.actions },
          h('button', { style: busy ? { ...S.button, ...S.buttonDisabled } : S.button, onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          message ? h('span', { style: message.kind === 'ok' ? S.ok : S.bad }, message.text) : null,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 放在设置侧栏的顶层列表里（账号与余额 / 通用设置 / … 那一列），
        // order 50：排在「插件守护 45」之后、「会话修复 60」之前。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'heartprint',
          order: 50,
          label: () => '心印',
        }, HeartprintSettings))
      },
    }
  },
})
