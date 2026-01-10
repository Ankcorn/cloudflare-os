import { useState } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi } from '@gadgets/workshop-shared/api'
import { Card, Form, Input, Button, Typography, Alert, Spin } from 'antd'

const { Title, Text } = Typography

interface LoginPageProps {
  rpcStub: RpcStub<PublicApi>
  onLoginSuccess?: () => void
}

export default function LoginPage({ rpcStub, onLoginSuccess }: LoginPageProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (values: { username: string; password: string }) => {
    setLoading(true)
    setError(null)

    try {
      const token = await rpcStub.login(values.username, values.password)
      if (token) {
        localStorage.setItem('authToken', token)
        // Trigger re-authentication check in parent
        if (onLoginSuccess) {
          onLoginSuccess()
        } else {
          window.location.reload()
        }
      } else {
        setError('Invalid username or password')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#f5f5f5',
        padding: '0 16px',
      }}
    >
      <Card
        style={{
          maxWidth: 400,
          width: '100%',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <Title level={1} style={{ marginBottom: 8 }}>
            Gadgets Workshop
          </Title>
          <Text type="secondary">
            Sign in to your account
          </Text>
        </div>

        <Form
          onFinish={handleSubmit}
          layout="vertical"
          size="large"
        >
          <Form.Item
            label="Username"
            name="username"
            rules={[{ required: true, message: 'Please input your username!' }]}
          >
            <Input
              disabled={loading}
              autoFocus
              autoComplete="username"
            />
          </Form.Item>

          <Form.Item
            label="Password"
            name="password"
            rules={[{ required: true, message: 'Please input your password!' }]}
          >
            <Input.Password
              disabled={loading}
              autoComplete="current-password"
            />
          </Form.Item>

          {error && (
            <Alert
              message={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}

          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              size="large"
              block
            >
              Sign in
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}